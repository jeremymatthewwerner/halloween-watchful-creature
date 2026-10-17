# Building the Pumpkin Critic

Expect about 1–2 hours, plus soldering for the eyes.

## 1. Carve and hide the electronics
1. Cut a **service hatch** in the back or bottom of the foam pumpkin, big enough for the speakerphone (~5"). Keep the cut-out piece to use as a door.
2. Carve the **eyes** about 1.5" across, and a **wide mouth**.
3. Glue **black tulle** behind the mouth. The camera sees through it and sound passes through it, but from outside it just looks dark.
4. Mount the **webcam** behind the mouth, lens against the tulle, aimed slightly down at where visitors stand (1–2 m away). Its clip or a hot-glued foam block holds it.
5. Put the **speakerphone** inside, facing the mouth, sitting flat. Its mics need open air, so keep foam scraps away from it.
6. Run the cables out of the hatch to the **powered USB hub** behind the pumpkin. Run the **16 ft active USB cable** from the hub to the Mac.
7. Dress him up with a beret or chef's toque, a monocle and a bow tie.
8. Set the **candy bowl** right in front, so visitors stop at the sweet spot for the camera and mic.

## 2. Lighting
Clamp the warm LED light so it shines on the **visitors**, not into the camera. Test at night: the dashboard video should clearly show costume colors at the candy bowl.

## 3. Eyes (NeoPixels)
```
Arduino 5V  ───────────────┬──────────────┐
Arduino GND ─────────────┬─┼────────────┐ │
Arduino D6 ──[330Ω]── Jewel #1 DIN      │ │
                       Jewel #1 DOUT ── Jewel #2 DIN
                       (5V / GND of both jewels to the rails above)
```
1. Solder three wires (5V, GND, DIN) to Jewel #1. Then chain Jewel #1 **DOUT** to Jewel #2 **DIN**, plus 5V and GND.
2. Put the 330 Ω resistor in the data line (on the breadboard is fine).
3. Hot-glue one jewel behind each carved eye, facing out. A scrap of white paper or tulle in front diffuses the light nicely.
4. Plug the Arduino into the USB hub.

**No NeoPixels yet?** Use two plain LEDs from the Arduino kit:
1. In the firmware, set `#define EYES_NEOPIXEL 0`.
2. Wire each LED's long leg to **D3** or **D5** through a 220 Ω resistor, and its short leg to GND.
3. They glow and pulse with the voice in one color. Switch back to `1` when the jewels arrive.

### Flash the firmware
1. Install the [Arduino IDE](https://www.arduino.cc/en/software).
2. In **Tools → Manage Libraries**, install **Adafruit NeoPixel**.
3. Open `firmware/creature_body/creature_body.ino`, choose **Arduino Uno** and its port, then click **Upload**.
4. Test it in **Serial Monitor** (115200 baud, newline line ending). Type each of these and watch the eyes:

| Command | What should happen |
|---|---|
| `M eyes` | eyes mode turns on |
| `S idle` | orange flicker |
| `S speaking` | speaking color |
| `L 255` | bright |
| (stop typing for 2 s) | eyes dim to "sleeping"; that's the fail-safe |

5. Close Serial Monitor. The app can't open the port while it's open.
6. In `.env`, keep `BODY_SERIAL_PORT=auto` and `BODY_MODES=eyes`. When the server starts it logs `[body] connected to /dev/tty.usbmodem…`.

## 4. Jaw (optional, last)
- SG90 signal → **D9**, 5V and GND to the rails.
- Attach a hinged jaw piece (cut from the pumpkin's mouth) to the servo horn with a stiff wire linkage.
- Tune `JAW_CLOSED_DEG` and `JAW_OPEN_DEG` in the firmware, then set `BODY_MODES=eyes,jaw`.

## 5. Animatronic relay (parked)
- Relay module IN → **D7**.
- Wire the relay's COM/NO contacts in parallel with the prop's trigger button or wired activator.
- **Low-voltage trigger circuits only. Never switch mains with this.**
- Set `BODY_MODES=eyes,relay`. The firmware "presses" for 400 ms when speech starts, with an 8 s cooldown.

## 6. Porch checklist (Halloween night)
- [ ] The Mac is plugged in, and `caffeinate -dis` is running (see README).
- [ ] The dashboard is open in Chrome. You clicked **Wake the creature**, and the camera, mic and speaker are selected in Settings.
- [ ] Walk-up test: you get greeted within about 2 s, and "what am I dressed as?" works.
- [ ] Volume: loud enough at the candy bowl, without echo.
- [ ] The **"How close counts as a visitor"** slider is set so people walking past on the sidewalk aren't greeted.
- [ ] You know where the kill switch is.
- [ ] Rain plan: everything is under the porch roof, with a clear bag over the hub.
