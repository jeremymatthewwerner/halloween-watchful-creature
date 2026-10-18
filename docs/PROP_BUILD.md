# Building the Pumpkin Critic

Expect about 1–2 hours, plus soldering for the eyes.

## 1. Carve and hide the electronics
**Printable template:** [templates/pumpkin-carving-template.pdf](templates/pumpkin-carving-template.pdf) has actual-size outlines for the eyes, mouth and back hatch, plus the steps below. Print it at **100% ("Actual size")** and check its ruler before cutting. The source is [templates/pumpkin-carving-template.html](templates/pumpkin-carving-template.html); to rebuild the PDF, open it in Chrome and print to PDF with no margins and no headers.

**Cutting a plastic craft pumpkin** (ours is 13" tall and hollow):
- **Hot knife:** your soldering iron works as one. Use an old or spare tip, because melted plastic ruins it.
- **Ventilate:** cut **outdoors or with a fan**, since melting plastic gives off nasty fumes.
- **Starter holes:** drill or melt a small hole at each corner of a cut-out, then cut between the holes. Forcing a cold blade into thin plastic cracks it.
- **Without heat:** Pumpkin Masters craft carving tools work too.

**What fits in a 13" pumpkin:**
- the webcam behind the mouth;
- **one** Logitech Z150 speaker (about 4.5" × 6.5"), or a speakerphone, inside;
- the second Z150 speaker sits hidden behind the pumpkin.

1. Cut a **service hatch** in the back, big enough for the speaker: **5" × 7"** with rounded corners, plus a 1.2" × 0.5" cable notch below it. Keep the cut-out piece to use as a door.
2. Carve **round eyes 1.5" across, centres 3" apart** (a NeoPixel Jewel fits behind each), and a **grin 6" wide and 2" tall at the centre**, with its top about 0.3" below the pumpkin's widest line.
3. Glue **black tulle** behind the mouth. The camera sees through it and sound passes through it, but from outside it just looks dark.
4. Mount the **webcam** behind the mouth, lens against the tulle at the centre of the grin. Its clip or a hot-glued foam block holds it. With the mouth about 26–30" off the porch floor (a crate helps), aim it level to about 10° upward, so that a child at the candy bowl is in frame from the waist up and an adult's head fits too. Check on the dashboard.
5. Put the **speakerphone** inside, facing the mouth, sitting flat. Its mics need open air, so keep foam scraps away from it.
6. Run the cables out of the hatch to the **powered USB hub** behind the pumpkin. Run the **16 ft active USB cable** from the hub to the Mac.
7. Dress him in his **tall black top hat, round spectacles and bow tie**: the look his persona talks about. (He's a costume *critic*, not a chef, so no toque.)
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
3. **Stop the creature server first** (`npm run dev` or the Pi service). It grabs the Arduino's port, and an upload then fails with "programmer is not responding".
4. Open `firmware/creature_body/creature_body.ino`, choose **Arduino Uno** and its port, then click **Upload**.
   - **The port** looks like `/dev/cu.usbmodem…`, or `/dev/cu.usbserial-…` / `cu.wchusbserial…` on clone boards. A USB-C hub can add a `usbmodem` port of its own; if the upload fails "not in sync", unplug the Arduino and see which port disappears.
   - **Still "not in sync" on the right port?** Boards with an FTDI USB chip (port `cu.usbserial-…`) often have the older bootloader: choose **Arduino Duemilanove or Diecimila**, Processor **ATmega328P**.
5. Test it in **Serial Monitor** (115200 baud, newline line ending). Type each of these and watch the eyes:

| Command | What should happen |
|---|---|
| `M eyes` | eyes mode turns on |
| `S idle` | orange flicker |
| `S speaking` | speaking color |
| `L 255` | bright |
| `F sparkle` | about a second of spinning rainbow with white twinkles, then back to normal (plain LEDs: a quick left-right twinkle) |
| `F gasp` | two quick blinks, then wide-eyed for a moment |
| `F slowblink` | a slow, thoughtful blink |
| (stop typing for 2 s) | eyes dim to "sleeping"; that's the fail-safe |

   State names are exact and lowercase (`S speaking`, not `S Speaking`), or the board answers `ERR state`.
   The `F` flourishes play over whatever state the eyes are in (even after the fail-safe has dimmed them), and an unknown one answers `ERR flourish`. In the app, new visitors and costume changes get a sparkle, the same visitors back after a while get a gasp, and the eyes slow-blink when the creature starts thinking.
6. Close Serial Monitor. The app can't open the port while it's open.
7. In `.env`, keep `BODY_SERIAL_PORT=auto` and `BODY_MODES=eyes`. When the server starts it logs `[body] connected to /dev/tty.usbmodem…`.

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
