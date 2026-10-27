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
- the webcam behind the mouth (its built-in mics are the creature's ears);
- **one** Logitech Z150 speaker (about 4.5" × 6.5") inside: the one **without** the volume knob, so the knob (also the power switch) stays reachable behind the pumpkin with the second speaker. The voice plays from both.
- the two eye cups and the Arduino with its breadboard.
- A USB speakerphone also fits instead of the Z150, if you get one.

1. Cut a **service hatch** in the back, big enough for the speaker: **5" × 7"** with rounded corners, plus a 1.2" × 0.5" cable notch below it. Keep the cut-out piece to use as a door (see **Back hatch door** below).
2. Carve **round eyes 1.5" across, centres 3" apart** (a NeoPixel Jewel fits behind each), and a **grin 6" wide and 2" tall at the centre**, with its top about 0.3" below the pumpkin's widest line.
3. Glue **black tulle** behind the mouth. The camera sees through it and sound passes through it, but from outside it just looks dark.
4. Mount the **webcam** behind the mouth, lens against the tulle at the centre of the grin. Its clip or a hot-glued foam block holds it. With the mouth about 26–30" off the porch floor (a crate helps), aim it level to about 10° upward, so that a child at the candy bowl is in frame from the waist up and an adult's head fits too. Check on the dashboard.
   - **Hide the C920's two activity lights.** They sit just left and right of the lens, and there's no software switch for them on a Mac. Cover each one with a small square of black electrical tape, or a dot of black marker or nail polish. Do this before you mount the camera, because the glow reflects off the tulle and the inside walls, washing out the picture and lighting up the mouth. Keep the lens and the speckled mic grilles at each end uncovered.
5. Put the **speaker** inside through the hatch, facing the mouth. Push its 3.5 mm plug **all the way** into the USB sound card's headphone jack (a half-seated plug is faint and hums), and plug the sound card into the hub. Then re-check echo: stay quiet while the creature talks, and make sure no 🧒 lines in the Conversation panel repeat its own words.
6. Run the cables out of the hatch to the **powered USB hub** behind the pumpkin. Run the **16 ft active USB cable** from the hub to the Mac.
7. Dress him in his **tall black top hat, round spectacles and bow tie**: the look his persona talks about. (He's a costume *critic*, not a chef, so no toque.)
8. Set the **candy bowl** right in front, so visitors stop at the sweet spot for the camera and mic.

### Back hatch door
It has to open again (for the NeoPixel swap and any fixes), so:
1. **Stop it falling in.** A hot knife removes a sliver of plastic, so a straight-cut door drops through. Either **bevel the cut** about 30° inward all round (the jack-o'-lantern lid trick, so it rests on the slanted edge), or hot-glue 3–4 small scrap **tabs** inside the door that overlap the opening by about ½".
2. **Hinge it** along the top edge with a strip of **black duct tape on the inside**: it swings up and gravity keeps it shut.
3. **Hold it shut** at the bottom with two small **Velcro** tabs or a pair of small adhesive **magnets**.
4. Leave the **cable notch** below the door open, so cables don't prop it ajar.

### What goes where (tethered to the Mac)
- **Inside the pumpkin:** the C920 behind the mouth (on its clip or a foam block), black tulle glued inside the mouth, one Z150 speaker, the two eye cups with their LEDs or Jewels, and the Arduino Uno with its breadboard (Velcro or hot glue), near the eyes so their wires stay short. Cables leave through the hatch notch: webcam USB, speaker cable, Arduino USB.
- **Behind the pumpkin:** the powered USB hub and its 12 V adapter (the webcam, USB sound card and Arduino plug into it), the second Z150 speaker with the volume knob, and a power strip on an outdoor extension cord for the hub and the speakers (one strip helps avoid hum). The 16 ft active USB cable runs from the hub to the Mac indoors.
- **On the pumpkin:** top hat, round spectacles, bow tie. **In front:** the candy bowl.

## 2. Lighting
Test at dusk with your porch light first: the dashboard video and the snapshots in the day's `log.html` should clearly show costume colors at the candy bowl. Only if they don't, clamp a warm LED flood (a BR30 2700K bulb gives soft, even light) so it shines on the **visitors**, not into the camera.

## 3. Eyes (NeoPixels)
```
Arduino 5V  ───────────────┬──────────────┐
Arduino GND ─────────────┬─┼────────────┐ │
Arduino D6 ──[330Ω]── Jewel #1 DIN      │ │
                       Jewel #1 DOUT ── Jewel #2 DIN
                       (5V / GND of both jewels to the rails above)
```
1. Solder **7 joints**: Jewel #1 gets PWR, GND, IN and OUT; Jewel #2 gets PWR, GND and IN (it has two GND holes: use either). For wire, cut **one** end off a kit jumper (about 9½" left): solder the cut end to the Jewel, and the pin end plugs into the breadboard. Wire each Jewel's PWR and GND **straight to the breadboard's + and – rails** (the Jewel's plated holes take one wire each), and chain only the data: a short pin-less piece from Jewel #1 OUT to Jewel #2 IN. Practise on the spare Jewel first.
   - **Through-holes:** strip about 5 mm, twist and lightly tin the wire (not the hole), push it in from the back (the side without LEDs), and solder from the back so solder flows into the hole; trim what pokes out on the LED side. Use a small flat (screwdriver, about 1/16") tip.
   - **Check before plugging in:** red wires only on +, black only on –, data into IN (not OUT), no strand touching a neighbouring hole. **If the USB cable gets hot or the Arduino's ON light stays off, unplug at once:** that's a 5V-to-GND short. Re-add the wires a step at a time to find it.
2. Put the 330 Ω resistor in the data line (on the breadboard is fine; a 220 Ω from the kit works too).
3. **Test before mounting:** Serial Monitor commands below. Then put a dab of hot glue over the joints for strain relief.
4. Mount each Jewel in an **eye cup** (below), LEDs facing the eye, and plug the Arduino into the USB hub.

**Soldering tips (for 7 small joints):**
- Iron at about 330–350 °C (625–660 °F); your lead-free solder melts at 217 °C. Use a clean, tinned tip, **not** the one you carved the pumpkin with. Ventilate.
- Tape the Jewel face-down so both hands are free. Strip about 3 mm of wire, twist it, and **tin** both the wire and the pad first; then touch them together with the iron for 2–3 s and hold still while it sets.
- A good joint is shiny, like a small volcano. Dull, balled or wobbly: reheat 2 s. Use little solder, so neighbouring pads don't bridge; if a pad won't melt within about 5 s, stop and re-tin the tip rather than cooking the pad.
- Red for 5V, black for GND, another colour for data.

**Eye cups** (made from scraps, one per eye):
1. Glue a circle of **white printer paper**, about 2" across, inside the pumpkin over the eye hole: it diffuses the light so the whole 1.5" eye glows.
2. Hot-glue a **½–¾" ring cut from a toilet-paper tube** (about 1.7" across) around the hole, over the paper. Notch its edge for the wires.
3. Hot-glue the Jewel (or poke a plain LED's legs) through the centre of a **cardboard disc** that covers the back of the ring, facing the eye.
4. Stick the disc onto the ring with two **Velcro** dots or tape, so you can pull it off to swap LEDs for Jewels. The light then sits about ½" behind the paper and glows evenly instead of showing bright dots.

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
   - **"Resource busy"?** Something else has the port open: Serial Monitor (a tab in the IDE's bottom panel), or a creature server still running (`npm run dev` / `npm start`, maybe from another Terminal window or app). Close or stop it, unplug the Arduino for 5 s, and upload again.
   - **Still "not in sync" on the right port?** Boards with an FTDI USB chip (port `cu.usbserial-…`) often have the older bootloader: choose **Arduino Duemilanove or Diecimila**, Processor **ATmega328P**.
5. Test it in **Serial Monitor** (38400 baud, newline line ending). Type each of these and watch the eyes:

| Command | What should happen |
|---|---|
| `M eyes` | eyes mode turns on |
| `S idle` | red-orange candle flicker, each LED flickering on its own; the center breathes toward dark purple, a warm white spark races round the rings every few seconds, and a black blink every few seconds |
| `S thinking` | a purple comet spinning round each ring, the two eyes in mirror image |
| `S listening` | a soft bright spot circling slowly round a steady center |
| `S speaking` then `L 255` | bright speaking color with a warm ripple going round; it whirls fast once as it gets loud, and every few seconds a black lid comes down over the eyes and back up |
| `F sparkle` | about a second of spinning rainbow with white twinkles, then back to normal (plain LEDs: a quick left-right twinkle) |
| `F gasp` | two quick blinks (fast black lids), then wide-eyed for a moment |
| `F slowblink` | a blink: a black lid comes down over the eyes and goes back up |
| (stop typing for 2 s) | eyes dim to "sleeping"; that's the fail-safe |

   Watch right after each Enter: 2 seconds after the last command, the fail-safe dims the eyes again.
   State names are exact and lowercase (`S speaking`, not `S Speaking`), or the board answers `ERR state`.
   The `F` flourishes play over whatever state the eyes are in (even after the fail-safe has dimmed them), and an unknown one answers `ERR flourish`. In the app, new visitors and costume changes get a sparkle, the same visitors back after a while get a gasp, and the eyes blink when the creature starts thinking.
6. Close Serial Monitor. The app can't open the port while it's open.
7. In `.env`, keep `BODY_SERIAL_PORT=auto` and `BODY_MODES=eyes`. When the server starts it logs `[body] connected to /dev/tty.usbmodem…`.

## 4. Jaw (optional, skipped this year)
The servo (a 9g SG90) is in the Arduino kit. The carving template has no jaw: the webcam sits behind the grin, so a jaw would need a separate hinged "chin" flap below the mouth, added to the template **before** carving.
- SG90 signal → **D9**, 5V and GND to the rails.
- Attach the chin flap to the servo horn with a **stiff wire linkage**: a pushrod with a small Z-bend at each end (a straightened large paperclip, or coat-hanger wire).
- Tune `JAW_CLOSED_DEG` and `JAW_OPEN_DEG` in the firmware, then set `BODY_MODES=eyes,jaw`.

## 5. Animatronic relay (parked)
- Relay module IN → **D7**.
- Wire the relay's COM/NO contacts in parallel with the prop's trigger button or wired activator.
- **Low-voltage trigger circuits only. Never switch mains with this.**
- Set `BODY_MODES=eyes,relay`. The firmware "presses" for 400 ms when speech starts, with an 8 s cooldown.

## 6. Porch checklist (Halloween night)
- [ ] The Mac is plugged in, and `caffeinate -dis` is running (see README).
- [ ] Chrome was started with `--autoplay-policy=no-user-gesture-required` (README, **Watchdog**), so it can wake itself after a reload.
- [ ] The dashboard is open. You clicked **Wake the creature**, and the camera, mic and speaker are selected in Settings. The server log shows `[body] connected to …`.
- [ ] Voice picked, **Spookiness** set (Auto is a good default), quick modes off, spooky sounds and lure toggled as you like.
- [ ] The phone remote works on your phone (`REMOTE_PIN`). To test push alerts (`NTFY_TOPIC`), unplug the Arduino for a moment: an "Arduino disconnected" push should reach the ntfy app.
- [ ] Walk-up test: you get greeted within about 2 s, and "what am I dressed as?" works.
- [ ] Volume: loud enough at the candy bowl, without echo.
- [ ] The **"How close counts as a visitor"** slider is set so people walking past on the sidewalk aren't greeted.
- [ ] You know where the kill switch is (dashboard and phone), and `MAX_VOICE_MINUTES_PER_DAY` is set to a cap you're happy with.
- [ ] A small sign: "This pumpkin talks back (it's AI, and it records)".
- [ ] Rain plan: everything is under the porch roof, with a clear bag over the hub.
