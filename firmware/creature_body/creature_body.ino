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
//                      | slowblink (a blink: the lid comes down and goes back up, 0.375 s)
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
// Blinks: a black lid comes down over each eye and goes back up, at uneven gaps (see blinkGap),
// shorter while speaking; about one in six is a double. Each is 0.85-1.15x BLINK_MS long, the right
// eye starting it 20-40 ms after the left. And while speaking, a whirl (the ripple spins about 1.5
// extra turns) when the voice jumps loud, at most every 5 s but at least every 9 s. Keep in sync
// with LivelyEyes in web/eyeFlourish.ts.
const unsigned int LID_DOWN_MS = 145;
const unsigned int LID_SHUT_MS = 65;
const unsigned int BLINK_MS = 375;  // down, shut, then up for the rest
const uint8_t LID_COLOR[3] = {0, 0, 0};
const unsigned int SPEAK_BLINK_GAP[3] = {1200, 2500, 9000};  // min, mean over it, max (ms)
const unsigned int REST_BLINK_GAP[3] = {2000, 3500, 12000};
const uint8_t DOUBLE_BLINK_ODDS = 6;  // one blink in this many is a double
const unsigned int DOUBLE_BLINK_GAP_MS = 120;
const uint8_t EYE_TOP_PIXEL = 1;           // the ring pixel (1-6) at the top of each jewel as mounted
const float LID_OPEN = 1.3;                // the lid's edge when open: just above the top pixel
const unsigned int WHIRL_MS = 600;
const float WHIRL_PEAK = 0.7;
const unsigned long WHIRL_COOLDOWN_MS = 5000;
const unsigned long WHIRL_AT_LEAST_EVERY_MS = 9000;
// While idle: every 3-7 s a warm white spark races IDLE_SPIN_TURNS round each ring (from a random
// pixel, a random way round, the eyes in mirror image), and the center breathes toward dark purple
// every PULSE_MS. Keep in sync with LivelyEyes in web/eyeFlourish.ts.
const unsigned int IDLE_SPIN_MS = 1600;
const uint8_t IDLE_SPIN_TURNS = 2;
const uint8_t SPARK_COLOR[3] = {255, 190, 90};
const unsigned int PULSE_MS = 3200;
const uint8_t PULSE_COLOR[3] = {60, 0, 90};

enum State { SLEEPING, IDLE, LISTENING, THINKING, SPEAKING, STATE_COUNT };
const char *STATE_NAMES[STATE_COUNT] = {"sleeping", "idle", "listening", "thinking", "speaking"};
enum EyeStyle { FLICKER, GLOW, BLINK };
// One-shot eye animations (the F command). Keep timings in sync with web/eyeFlourish.ts.
enum Flourish { FL_NONE, FL_SPARKLE, FL_GASP, FL_SLOWBLINK, FLOURISH_COUNT };
const char *FLOURISH_NAMES[FLOURISH_COUNT] = {"", "sparkle", "gasp", "slowblink"};
const unsigned int FLOURISH_MS[FLOURISH_COUNT] = {0, 1200, 900, BLINK_MS};
// What the playing flourish does to the eyes this frame.
struct FlourishFrame {
  float lid;      // brightness multiplier: 0 = shut, 1 = normal
  float wide;     // 0..1: how far brightness is pushed toward full (wide-eyed)
  float sparkle;  // 0..1: how much of the sparkle shows over the normal look
  unsigned long t;  // ms since the flourish started
  float edge;     // where a blinking lid's edge is (see lidEdge): LID_OPEN when there's none
};
// One NeoPixel's brightness (0..1) and hue shift (degrees from the state's color) this frame.
struct Motion {
  float b;
  float hue;
};

Adafruit_NeoPixel eyes(EYE_PIXELS, EYES_PIN, NEO_GRB + NEO_KHZ800);
Servo jaw;

// Default palette (pumpkin) until the server sends the character's colors.
uint8_t palette[STATE_COUNT][3] = {
  {42, 10, 0}, {255, 61, 0}, {255, 176, 0}, {155, 48, 255}, {255, 208, 0}};
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

float flicker = 0.8;           // plain-LED eyes: one candle flicker for both
float pixelFlicker[EYE_PIXELS];  // NeoPixel eyes: each LED's own candle flicker
float speakSpin = 0;             // how far round the speaking ripple is (turns)
unsigned long lastRenderAt = 0;
bool wasBlinking = false, wasSpeaking = false;
float lastLevel = 0;
unsigned long blinkAt = 0, nextBlinkAt = 0, whirlAt = 0, whirlBy = 0;
float whirlSpin = 0;             // the whirl's extra spin this frame (turns a second)
float lidAt[2] = {LID_OPEN, LID_OPEN};  // where each eye's lid edge is this frame (see lidEdge)
float blinkScale = 1, blinkLag = 0;     // this blink's speed (x BLINK_MS), and the right eye's lag (ms)
bool wasIdle = false;
unsigned long spinAt = 0, nextSpinAt = 0;
uint8_t spinFrom = 0;            // the ring pixel (0-5) the idle spin started from (left eye)
int8_t spinDir = 1;              // which way round it goes (left eye)
bool spinning = false;           // an idle spin is playing this frame

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

// A gasp's quick blinks: the same lid as a blink, sped up to GASP_BLINK_MS. Where its edge is t ms
// after it starts (see lidEdge).
const unsigned int GASP_BLINK_MS = 150;
float gaspLid(float t) {
  return lidEdge(t * BLINK_MS / GASP_BLINK_MS);
}

FlourishFrame flourishFrame(unsigned long now) {
  FlourishFrame f = {1, 0, 0, 0, LID_OPEN};
  if (flourish == FL_NONE) return f;
  f.t = now - flourishAt;
  if (f.t >= FLOURISH_MS[flourish]) {
    flourish = FL_NONE;  // done: back to the plain state look
    return f;
  }
  switch (flourish) {
    case FL_GASP:  // two quick lid blinks, then wide-eyed, easing back
      f.edge = min(gaspLid(f.t), gaspLid(f.t - 220.0));
      if (f.t >= 370) f.wide = 1 - ease((f.t - 370) / 530.0);
      break;
    case FL_SLOWBLINK:  // a blink like the idle ones: the lid comes down from the top and goes back up
      f.edge = lidEdge(f.t);
      break;
    case FL_SPARKLE:  // full burst, fading back to normal over the last 300 ms
      f.sparkle = f.t < 900 ? 1 : 1 - (f.t - 900) / 300.0;
      break;
    default:
      break;
  }
  return f;
}

// How far through a cycle of periodMs the clock is, 0..1.
float phase(unsigned long now, unsigned long periodMs) {
  return (now % periodMs) / (float)periodMs;
}

// Wraps x into [0, m).
float wrap(float x, float m) {
  x = fmod(x, m);
  return x < 0 ? x + m : x;
}

// How one NeoPixel moves in the current state. p: 0 = jewel center, 1-6 = ring; the two eyes turn
// in mirror image. Keep in sync with pixelMotion() in web/eyeFlourish.ts (the dashboard preview).
//   speaking:  brightness follows the voice, from dim between words to full on loud ones, with a
//              ripple of brightness and warmer hue going round, spinning faster the louder the voice
//              (speakSpin); livelyStep() adds blinks and whirls
//   thinking:  a comet spins round the ring, its tail fading and drifting in hue
//   listening: a soft bright spot circles slowly round a steady center
//   sleeping:  a faint ember drifting round
//   idle:      every LED flickers on its own (flicker), a slow hue swirl (glow), or a blink;
//              renderEyes() adds a purple pulse in the center and livelyStep()'s spinning spark
Motion pixelMotion(unsigned long now, uint8_t eye, uint8_t p, float flick) {
  float ring = p - 1.0;
  float dir = eye == 0 ? 1 : -1;
  switch (state) {
    case SPEAKING: {
      float base = 0.1 + 0.9 * level;
      if (p == 0) return {base, 0};
      float w = cos(TWO_PI * (ring / 6 - dir * speakSpin));
      return {base * (0.65 + 0.35 * w), -12 * (1 + w)};  // toward warmer, never greener
    }
    case THINKING: {
      if (p == 0) return {0.25 + 0.1 * sin(now / 250.0), 0};
      // How far (in pixels) this LED is behind the comet's head, which goes round every 900 ms.
      float behind = wrap(6 * phase(now, 900) - dir * ring, 6);
      float k = 1 - behind / 6;
      return {0.06 + 0.94 * k * k * k, -12 * behind};
    }
    case LISTENING: {
      if (p == 0) return {0.9, 0};
      float w = cos(TWO_PI * (ring / 6 - dir * phase(now, 2400)));
      return {0.8 + 0.2 * w, 12 * w};
    }
    case SLEEPING:
      if (p == 0) return {0.2, 0};
      return {0.225 + 0.075 * cos(TWO_PI * (ring / 6 - dir * phase(now, 6000))), 0};
    default:  // IDLE
      if (eyeStyle == FLICKER) return {flick, 0};
      if (eyeStyle == BLINK && now % 4000 < 150) return {0.05, 0};
      if (p == 0) return {0.8, 0};
      return {0.8, 15 * cos(TWO_PI * (ring / 6 - dir * phase(now, 4000)))};
  }
}

// The whirl's extra spin (turns a second) t ms after it started: up to 4, easing in and out.
float whirlRate(unsigned long t) {
  return t < WHIRL_MS ? 4 * sin(PI * t / WHIRL_MS) : 0;
}

// Where the lid's edge is t ms into a blink (pixels sit from -1, bottom, to 1, top): coming down,
// shut, then going up for the rest.
float lidEdge(float t) {
  if (t < 0 || t >= BLINK_MS) return LID_OPEN;
  if (t < LID_DOWN_MS) return LID_OPEN - 2 * LID_OPEN * ease(t / (float)LID_DOWN_MS);
  const unsigned int up = LID_DOWN_MS + LID_SHUT_MS;
  if (t < up) return -LID_OPEN;
  return -LID_OPEN + 2 * LID_OPEN * ease((t - up) / (float)(BLINK_MS - up));
}

// The wait before the next blink: at least gap[0] ms, usually a little more, now and then much more
// (up to gap[2]): an exponential tail with mean gap[1] over the minimum.
unsigned long blinkGap(const unsigned int *gap) {
  float r = random(10000) / 10000.0;
  return min((float)gap[2], gap[0] - gap[1] * log(1 - r));
}

// How much of pixel p (0 = center, 1-6 = ring) the lid covers with its edge at `edge`: 0..1, soft-edged.
float lidCover(float edge, uint8_t p) {
  float y = p == 0 ? 0 : cos(TWO_PI * ((int)p - EYE_TOP_PIXEL) / 6.0);
  return constrain((y - edge) / 0.6 + 0.5, 0.0, 1.0);
}

// Moves the blinks and whirls on to `now`: sets lidAt (each eye) and whirlSpin. The first blink
// comes 1.5-4 s after the eyes settle into speaking, idle or sleeping.
void livelyStep(unsigned long now) {
  bool speaking = state == SPEAKING;
  bool idle = state == IDLE;
  bool blinks = speaking || idle || state == SLEEPING;
  if (blinks && !wasBlinking) nextBlinkAt = now + random(1500, 4000);
  if (speaking && !wasSpeaking) whirlBy = now + WHIRL_AT_LEAST_EVERY_MS;
  if (idle && !wasIdle) nextSpinAt = now + random(1000, 3000);
  wasBlinking = blinks;
  wasSpeaking = speaking;
  wasIdle = idle;
  bool rising = level >= WHIRL_PEAK && lastLevel < WHIRL_PEAK;
  lastLevel = level;
  if (blinks && (long)(now - nextBlinkAt) >= 0) {
    blinkAt = now;
    blinkScale = random(85, 116) / 100.0;
    blinkLag = random(20, 41);
    unsigned long length = BLINK_MS * blinkScale + blinkLag;
    nextBlinkAt = now + (random(DOUBLE_BLINK_ODDS) == 0 ? length + DOUBLE_BLINK_GAP_MS
                                                        : blinkGap(speaking ? SPEAK_BLINK_GAP : REST_BLINK_GAP));
  }
  if (speaking && ((rising && now - whirlAt >= WHIRL_COOLDOWN_MS) || (long)(now - whirlBy) >= 0)) {
    whirlAt = now;
    whirlBy = now + WHIRL_AT_LEAST_EVERY_MS;
  }
  if (idle && (long)(now - nextSpinAt) >= 0) {
    spinAt = now;
    spinFrom = random(6);
    spinDir = random(2) ? 1 : -1;
    nextSpinAt = now + IDLE_SPIN_MS + random(3000, 7000);
  }
  float t = now - blinkAt;
  lidAt[0] = blinks ? lidEdge(t / blinkScale) : LID_OPEN;
  lidAt[1] = blinks ? lidEdge((t - blinkLag) / blinkScale) : LID_OPEN;
  whirlSpin = speaking ? whirlRate(now - whirlAt) : 0;
  spinning = idle && now - spinAt < IDLE_SPIN_MS;
}

// How much of the idle center is PULSE_COLOR at `now`: 0 to 0.8 and back, every PULSE_MS.
float idlePulse(unsigned long now) {
  float s = sin(PI * (now % PULSE_MS) / PULSE_MS);
  return 0.8 * s * s;
}

// How much of the spark ring pixel p (1-6) shows t ms into a spin that started at ring pixel `from`
// (0-5) going `dir` round: full at the head, a tail fading over 2.5 pixels behind it, and the whole
// spin fading in and out over 150 ms at its ends.
float sparkAt(unsigned long t, float from, float dir, uint8_t p) {
  if (p == 0 || t >= IDLE_SPIN_MS) return 0;
  float head = from + dir * 6 * IDLE_SPIN_TURNS * ease(t / (float)IDLE_SPIN_MS);
  float behind = wrap(dir * (head - (p - 1)), 6);
  float k = behind > 5.5 ? (behind - 5.5) / 0.5 : max(0.0, 1 - behind / 2.5);
  return k * min(1.0, min(t / 150.0, (IDLE_SPIN_MS - t) / 150.0));
}

// `c` (0-255 each, scaled by MAX_BRIGHTNESS like the eye colors) mixed `k` (0..1) into r, g, b.
void mixIn(float &r, float &g, float &b, const uint8_t *c, float k) {
  r += (c[0] * MAX_BRIGHTNESS - r) * k;
  g += (c[1] * MAX_BRIGHTNESS - g) * k;
  b += (c[2] * MAX_BRIGHTNESS - b) * k;
}

// Turns a color `degrees` round the color wheel, keeping its saturation and brightness.
void shiftHue(float &r, float &g, float &b, float degrees) {
  float mx = max(r, max(g, b));
  float c = mx - min(r, min(g, b));
  if (degrees == 0 || c <= 0) return;
  float h = mx == r ? fmod((g - b) / c, 6) : mx == g ? (b - r) / c + 2 : (r - g) / c + 4;
  h = wrap(h + degrees / 60, 6);
  float x = c * (1 - fabs(fmod(h, 2) - 1));
  float m = mx - c;
  float rgb[6][3] = {{c, x, 0}, {x, c, 0}, {0, c, x}, {0, x, c}, {x, 0, c}, {c, 0, x}};
  uint8_t sector = (uint8_t)h % 6;
  r = rgb[sector][0] + m;
  g = rgb[sector][1] + m;
  b = rgb[sector][2] + m;
}

void renderEyes(unsigned long now) {
  FlourishFrame f = flourishFrame(now);
  livelyStep(now);
#if EYES_NEOPIXEL
  // The speaking ripple goes round faster the louder the voice: a lazy drift when quiet, quick
  // when loud. Keep in sync with speakSpinRate() in web/eyeFlourish.ts.
  float dt = min(now - lastRenderAt, 100UL) / 1000.0;
  lastRenderAt = now;
  speakSpin = wrap(speakSpin + dt * (0.4 + 2.6 * level + whirlSpin), 1);
  const uint8_t *c = palette[state];
  // Sparkle: a rainbow spinning around each jewel's ring (the two eyes half a turn apart),
  // the centers flashing white first, and a white twinkle on a random pixel about every third frame.
  uint8_t twinkle = random(EYE_PIXELS * 3);
  for (uint8_t i = 0; i < EYE_PIXELS; i++) {
    // The per-pixel math takes a few ms: keep up with the serial input (64-byte buffer) halfway through.
    if (i == 7) readSerial();
    pixelFlicker[i] += (random(55, 100) / 100.0 - pixelFlicker[i]) * 0.15;
    uint8_t p = i % 7;  // 0 = jewel center, 1-6 = ring
    Motion m = pixelMotion(now, i / 7, p, pixelFlicker[i]);
    float b = (m.b + (1 - m.b) * f.wide) * f.lid * MAX_BRIGHTNESS;
    float r = c[0], g = c[1], bl = c[2];
    shiftHue(r, g, bl, m.hue);
    r *= b;
    g *= b;
    bl *= b;
    if (state == IDLE) {
      if (p == 0) mixIn(r, g, bl, PULSE_COLOR, idlePulse(now));
      // The right eye spins in mirror image: from the mirrored pixel, the other way round.
      else if (spinning) {
        unsigned long st = now - spinAt;
        mixIn(r, g, bl, SPARK_COLOR, i < 7 ? sparkAt(st, spinFrom, spinDir, p) : sparkAt(st, (6 - spinFrom) % 6, -spinDir, p));
      }
    }
    if (f.sparkle > 0) {
      uint32_t s = (i == twinkle || (p == 0 && f.t < 200))
                       ? 0xFFFFFFUL
                       : Adafruit_NeoPixel::ColorHSV((uint16_t)(p * 65536UL / 6 + f.t * 66UL + (i / 7) * 32768UL));
      // Full color, still under the MAX_BRIGHTNESS cap.
      r += ((uint8_t)(s >> 16) * MAX_BRIGHTNESS - r) * f.sparkle;
      g += ((uint8_t)(s >> 8) * MAX_BRIGHTNESS - g) * f.sparkle;
      bl += ((uint8_t)s * MAX_BRIGHTNESS - bl) * f.sparkle;
    }
    mixIn(r, g, bl, LID_COLOR, lidCover(min(lidAt[i / 7], f.edge), p));  // a blink: the lid on top of everything
    eyes.setPixelColor(i, (uint8_t)r, (uint8_t)g, (uint8_t)bl);
  }
  eyes.show();
#else
  float base = stateBrightness(now);
  float b = (base + (1 - base) * f.wide) * f.lid;
  for (uint8_t i = 0; i < 2; i++) {
    float e = b * (1 - lidCover(min(lidAt[i], f.edge), 0));  // one LED: the lid just dims it
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
  // 38400, not 115200: eyes.show() turns interrupts off for ~0.4 ms each frame, long enough to lose
  // bytes at 115200. Keep in sync with BODY_BAUD in server/body/protocol.ts.
  Serial.begin(38400);
  pinMode(RELAY_PIN, OUTPUT);
  setRelay(false);
  eyes.begin();
  eyes.clear();
  eyes.show();
  for (uint8_t i = 0; i < 2; i++) pinMode(PLAIN_EYE_PINS[i], OUTPUT);
  randomSeed(analogRead(A0));
  for (uint8_t i = 0; i < EYE_PIXELS; i++) pixelFlicker[i] = 0.8;
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
