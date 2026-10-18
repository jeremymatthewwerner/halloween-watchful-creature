// Watchful Creature body controller (Arduino Uno / Nano / compatible).
//
// Drives the creature's body from line commands sent by the Mac/Pi server over USB:
//   M eyes,jaw,relay   enable modes (any subset, or "M none")
//   P <state> r g b    eye color for a state
//   Y flicker|glow|blink  idle eye style
//   S <state>          sleeping | idle | listening | thinking | speaking
//   L <0-255>          voice loudness
//   F <effect>         one-shot eye flourish over the current state, then back to normal:
//                      sparkle (rainbow burst, 1.2 s) | gasp (double blink, then wide-eyed, 0.9 s)
//                      | slowblink (slow, thoughtful blink, 1.4 s)
// If no line arrives for 2 seconds (page closed, cable pulled) everything fails safe:
// eyes dim to "sleeping", relay opens, jaw closes, and any flourish stops.
//
// Wiring (see docs/PROP_BUILD.md):
//   NeoPixel eyes: two 7-LED jewels chained, data in -> D6 (through a ~330 ohm resistor), 5V, GND
//   ...or plain LED eyes (set EYES_NEOPIXEL to 0): one LED per eye on D3 and D5, each through a 220 ohm resistor to GND
//   Jaw servo (SG90): signal -> D9, 5V, GND
//   Relay module (animatronic trigger): IN -> D7, 5V, GND
//
// Requires the "Adafruit NeoPixel" library (Arduino IDE: Tools > Manage Libraries).

#include <Adafruit_NeoPixel.h>
#include <Servo.h>

// ---- hardware config ----
// 1 = NeoPixel eyes (full color per state). 0 = two plain LEDs from the starter kit
// (single color, brightness still follows the state and the voice).
#define EYES_NEOPIXEL 1
const uint8_t PLAIN_EYE_PINS[2] = {3, 5};  // PWM pins
const uint8_t EYES_PIN = 6;
const uint8_t EYE_PIXELS = 14;           // 2 x NeoPixel Jewel 7
const float MAX_BRIGHTNESS = 0.45;       // keeps total current safe on USB power
// Eyes see LED brightness on a curve, not linearly: without correction, 25% power looks about
// half as bright as full, so sleeping and speaking look alike. 2.8 is the usual LED gamma.
const float PLAIN_EYE_GAMMA = 2.8;
const uint8_t RELAY_PIN = 7;
const bool RELAY_ACTIVE_HIGH = true;     // most blue relay modules are active-high; flip if yours is inverted
const unsigned long RELAY_PULSE_MS = 400;     // how long to "press" the prop's trigger
const unsigned long RELAY_COOLDOWN_MS = 8000; // let the prop finish its animation
const uint8_t SERVO_PIN = 9;
const int JAW_CLOSED_DEG = 90;
const int JAW_OPEN_DEG = 125;
const unsigned long FAILSAFE_MS = 2000;

enum State { SLEEPING, IDLE, LISTENING, THINKING, SPEAKING, STATE_COUNT };
const char *STATE_NAMES[STATE_COUNT] = {"sleeping", "idle", "listening", "thinking", "speaking"};
enum EyeStyle { FLICKER, GLOW, BLINK };
// One-shot eye animations (the F command). Keep timings in sync with web/eyeFlourish.ts.
enum Flourish { FL_NONE, FL_SPARKLE, FL_GASP, FL_SLOWBLINK, FLOURISH_COUNT };
const char *FLOURISH_NAMES[FLOURISH_COUNT] = {"", "sparkle", "gasp", "slowblink"};
const unsigned int FLOURISH_MS[FLOURISH_COUNT] = {0, 1200, 900, 1400};
// What the playing flourish does to the eyes this frame.
struct FlourishFrame {
  float lid;      // brightness multiplier: 0 = shut, 1 = normal
  float wide;     // 0..1: how far brightness is pushed toward full (wide-eyed)
  float sparkle;  // 0..1: how much of the sparkle shows over the normal look
  unsigned long t;  // ms since the flourish started
};

Adafruit_NeoPixel eyes(EYE_PIXELS, EYES_PIN, NEO_GRB + NEO_KHZ800);
Servo jaw;

// Default palette (pumpkin) until the server sends the character's colors.
uint8_t palette[STATE_COUNT][3] = {
  {42, 10, 0}, {255, 106, 0}, {255, 176, 0}, {155, 48, 255}, {255, 208, 0}};
EyeStyle eyeStyle = FLICKER;
bool modeEyes = true, modeJaw = false, modeRelay = false;

State state = SLEEPING;
float level = 0;          // 0..1, smoothed
float targetLevel = 0;
unsigned long lastLineAt = 0;
unsigned long relayOnAt = 0, relayLastPulseAt = 0;
bool relayOn = false;
int lastJawDeg = -1;
Flourish flourish = FL_NONE;
unsigned long flourishAt = 0;

char line[48];
uint8_t lineLen = 0;

void setRelay(bool on) {
  relayOn = on;
  digitalWrite(RELAY_PIN, (on == RELAY_ACTIVE_HIGH) ? HIGH : LOW);
}

int stateFromName(const char *name) {
  for (int i = 0; i < STATE_COUNT; i++) if (strcmp(name, STATE_NAMES[i]) == 0) return i;
  return -1;
}

void applyModes(const char *list) {
  modeEyes = strstr(list, "eyes") != NULL;
  modeJaw = strstr(list, "jaw") != NULL;
  modeRelay = strstr(list, "relay") != NULL;
  if (modeJaw && !jaw.attached()) { jaw.attach(SERVO_PIN); lastJawDeg = -1; }
  if (!modeJaw && jaw.attached()) { jaw.write(JAW_CLOSED_DEG); delay(150); jaw.detach(); }
  if (!modeRelay) setRelay(false);
  if (!modeEyes) {
    eyes.clear();
    eyes.show();
    for (uint8_t i = 0; i < 2; i++) analogWrite(PLAIN_EYE_PINS[i], 0);
  }
}

void setState(State s) {
  if (s == SPEAKING && state != SPEAKING && modeRelay &&
      millis() - relayLastPulseAt > RELAY_COOLDOWN_MS) {
    setRelay(true);
    relayOnAt = relayLastPulseAt = millis();
  }
  state = s;
  if (s != SPEAKING) targetLevel = 0;
}

void handleLine(char *cmd) {
  lastLineAt = millis();
  char *arg = cmd + 1;
  while (*arg == ' ') arg++;
  switch (cmd[0]) {
    case 'S': {
      int s = stateFromName(arg);
      if (s >= 0) setState((State)s); else Serial.println(F("ERR state"));
      break;
    }
    case 'L':
      targetLevel = constrain(atoi(arg), 0, 255) / 255.0;
      break;
    case 'M':
      applyModes(arg);
      Serial.println(F("OK modes"));
      break;
    case 'P': {
      char name[12];
      int r, g, b;
      if (sscanf(arg, "%11s %d %d %d", name, &r, &g, &b) == 4) {
        int s = stateFromName(name);
        if (s >= 0) {
          palette[s][0] = constrain(r, 0, 255);
          palette[s][1] = constrain(g, 0, 255);
          palette[s][2] = constrain(b, 0, 255);
        }
      }
      break;
    }
    case 'Y':
      if (strcmp(arg, "flicker") == 0) eyeStyle = FLICKER;
      else if (strcmp(arg, "blink") == 0) eyeStyle = BLINK;
      else eyeStyle = GLOW;
      break;
    case 'F': {
      int f = -1;
      for (int i = 1; i < FLOURISH_COUNT; i++) if (strcmp(arg, FLOURISH_NAMES[i]) == 0) f = i;
      if (f > 0) {
        flourish = (Flourish)f;  // a new flourish replaces one already playing
        flourishAt = millis();
      } else {
        Serial.println(F("ERR flourish"));
      }
      break;
    }
    default:
      Serial.println(F("ERR unknown"));
  }
}

void readSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      line[lineLen] = 0;
      if (lineLen > 0) handleLine(line);
      lineLen = 0;
    } else if (lineLen < sizeof(line) - 1) {
      line[lineLen++] = c;
    }
  }
}

float flicker = 0.8;

// Eye brightness 0..1 for the current state, before any flourish.
float stateBrightness(unsigned long now) {
  switch (state) {
    case SPEAKING: return 0.35 + 0.65 * level;
    case THINKING: return 0.45 + 0.35 * sin(now / 250.0);
    case SLEEPING: return 0.25;
    default:
      if (eyeStyle == FLICKER) {
        // Candle flicker: drift toward random targets.
        flicker += (random(55, 100) / 100.0 - flicker) * 0.15;
        return flicker;
      }
      if (eyeStyle == BLINK && now % 4000 < 150) return 0.05;
      return 0.8;
  }
}

// Smooth 0..1 -> 0..1 (cosine ease in and out).
float ease(float x) {
  return 0.5 - 0.5 * cos(PI * constrain(x, 0.0, 1.0));
}

// A quick blink between start and end ms: open (1) outside, shut (0) at the midpoint.
float blinkLid(unsigned long t, unsigned long start, unsigned long end) {
  if (t < start || t >= end) return 1;
  return fabs(2.0 * (t - start) / (end - start) - 1);
}

FlourishFrame flourishFrame(unsigned long now) {
  FlourishFrame f = {1, 0, 0, 0};
  if (flourish == FL_NONE) return f;
  f.t = now - flourishAt;
  if (f.t >= FLOURISH_MS[flourish]) {
    flourish = FL_NONE;  // done: back to the plain state look
    return f;
  }
  switch (flourish) {
    case FL_GASP:  // blink-blink, then wide-eyed, easing back
      f.lid = blinkLid(f.t, 0, 150) * blinkLid(f.t, 220, 370);
      if (f.t >= 370) f.wide = 1 - ease((f.t - 370) / 530.0);
      break;
    case FL_SLOWBLINK:  // lids drift shut, rest a moment, drift open
      if (f.t < 550) f.lid = 1 - ease(f.t / 550.0);
      else if (f.t < 850) f.lid = 0;
      else f.lid = ease((f.t - 850) / 550.0);
      break;
    case FL_SPARKLE:  // full burst, fading back to normal over the last 300 ms
      f.sparkle = f.t < 900 ? 1 : 1 - (f.t - 900) / 300.0;
      break;
    default:
      break;
  }
  return f;
}

void renderEyes(unsigned long now) {
  float base = stateBrightness(now);
  FlourishFrame f = flourishFrame(now);
  float b = (base + (1 - base) * f.wide) * f.lid;
#if EYES_NEOPIXEL
  b *= MAX_BRIGHTNESS;
  const uint8_t *c = palette[state];
  // Sparkle: a rainbow spinning around each jewel's ring (the two eyes half a turn apart),
  // the centers flashing white first, and a white twinkle on a random pixel about every third frame.
  uint8_t twinkle = random(EYE_PIXELS * 3);
  for (uint8_t i = 0; i < EYE_PIXELS; i++) {
    float r = c[0] * b, g = c[1] * b, bl = c[2] * b;
    if (f.sparkle > 0) {
      uint8_t p = i % 7;  // 0 = jewel center, 1-6 = ring
      uint32_t s = (i == twinkle || (p == 0 && f.t < 200))
                       ? 0xFFFFFFUL
                       : Adafruit_NeoPixel::ColorHSV((uint16_t)(p * 65536UL / 6 + f.t * 66UL + (i / 7) * 32768UL));
      // Full color, still under the MAX_BRIGHTNESS cap.
      r += ((uint8_t)(s >> 16) * MAX_BRIGHTNESS - r) * f.sparkle;
      g += ((uint8_t)(s >> 8) * MAX_BRIGHTNESS - g) * f.sparkle;
      bl += ((uint8_t)s * MAX_BRIGHTNESS - bl) * f.sparkle;
    }
    eyes.setPixelColor(i, (uint8_t)r, (uint8_t)g, (uint8_t)bl);
  }
  eyes.show();
#else
  for (uint8_t i = 0; i < 2; i++) {
    float e = b;
    // Plain LEDs can't do colors, so the sparkle is brightness only: the eyes twinkle, alternating.
    if (f.sparkle > 0) e += ((((f.t / 70) + i) % 2 ? 1.0 : 0.3) - e) * f.sparkle;
    uint8_t duty = (uint8_t)(255 * pow(constrain(e, 0.0, 1.0), PLAIN_EYE_GAMMA));
    analogWrite(PLAIN_EYE_PINS[i], duty);
  }
#endif
}

void renderJaw() {
  int deg = JAW_CLOSED_DEG;
  if (state == SPEAKING) deg = JAW_CLOSED_DEG + (JAW_OPEN_DEG - JAW_CLOSED_DEG) * min(1.0, level * 1.6);
  if (abs(deg - lastJawDeg) >= 2) {  // skip tiny moves to avoid servo buzz
    jaw.write(deg);
    lastJawDeg = deg;
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  setRelay(false);
  eyes.begin();
  eyes.clear();
  eyes.show();
  for (uint8_t i = 0; i < 2; i++) pinMode(PLAIN_EYE_PINS[i], OUTPUT);
  randomSeed(analogRead(A0));
  Serial.println(F("READY creature_body 1"));
}

void loop() {
  static unsigned long lastFrame = 0;
  readSerial();
  unsigned long now = millis();

  if (now - lastLineAt > FAILSAFE_MS) {
    flourish = FL_NONE;  // flourishes end sooner anyway; never let one outlive the fail-safe
    if (state != SLEEPING) setState(SLEEPING);
  }
  if (relayOn && now - relayOnAt > RELAY_PULSE_MS) setRelay(false);

  if (now - lastFrame >= 16) {  // ~60 fps
    lastFrame = now;
    level += (targetLevel - level) * (targetLevel > level ? 0.6 : 0.2);
    if (modeEyes) renderEyes(now);
    if (modeJaw) renderJaw();
  }
}
