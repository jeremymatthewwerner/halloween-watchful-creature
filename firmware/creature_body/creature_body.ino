// Watchful Creature body controller (Arduino Uno / Nano / compatible).
//
// Drives the creature's body from line commands sent by the Mac/Pi server over USB:
//   M eyes,jaw,relay   enable modes (any subset, or "M none")
//   P <state> r g b    eye color for a state
//   Y flicker|glow|blink  idle eye style
//   S <state>          sleeping | idle | listening | thinking | speaking
//   L <0-255>          voice loudness
// If no line arrives for 2 seconds (page closed, cable pulled) everything fails safe:
// eyes dim to "sleeping", relay opens, jaw closes.
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

void renderEyes(unsigned long now) {
  float b;
  switch (state) {
    case SPEAKING: b = 0.35 + 0.65 * level; break;
    case THINKING: b = 0.45 + 0.35 * sin(now / 250.0); break;
    case SLEEPING: b = 0.25; break;
    default:
      if (eyeStyle == FLICKER) {
        // Candle flicker: drift toward random targets.
        flicker += (random(55, 100) / 100.0 - flicker) * 0.15;
        b = flicker;
      } else if (eyeStyle == BLINK && now % 4000 < 150) {
        b = 0.05;
      } else {
        b = 0.8;
      }
  }
#if !EYES_NEOPIXEL
  uint8_t duty = (uint8_t)(255 * pow(constrain(b, 0.0, 1.0), PLAIN_EYE_GAMMA));
  for (uint8_t i = 0; i < 2; i++) analogWrite(PLAIN_EYE_PINS[i], duty);
  return;
#endif
  b *= MAX_BRIGHTNESS;
  const uint8_t *c = palette[state];
  uint32_t color = eyes.Color(c[0] * b, c[1] * b, c[2] * b);
  for (uint8_t i = 0; i < EYE_PIXELS; i++) eyes.setPixelColor(i, color);
  eyes.show();
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

  if (now - lastLineAt > FAILSAFE_MS && state != SLEEPING) setState(SLEEPING);
  if (relayOn && now - relayOnAt > RELAY_PULSE_MS) setRelay(false);

  if (now - lastFrame >= 16) {  // ~60 fps
    lastFrame = now;
    level += (targetLevel - level) * (targetLevel > level ? 0.6 : 0.2);
    if (modeEyes) renderEyes(now);
    if (modeJaw) renderJaw();
  }
}
