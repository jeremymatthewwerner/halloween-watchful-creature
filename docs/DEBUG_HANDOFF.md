# Handoff to a local debugging session (2026-10-17)

**Context:** a talking Halloween pumpkin, "Jacques O'Lantern, Pumpkin Critic". Start with `README.md`, then `docs/DESIGN.md`. Work on branch `claude/laughing-ramanujan-tc0edf`.

## Status on the owner's Mac
- `npm run doctor` passes: `gpt-live-1` and `gpt-6-luna` are both available, and the vision test works (about 3.3 s).
- `npm run dev` works, and the dashboard at http://localhost:5173 runs in Chrome with the built-in camera and mic.
- The first greeting works. The repeat-greeting bug is fixed.

## Open bug: return visits aren't greeted
To reproduce:
1. Let Jacques greet you.
2. Walk out of frame until the Conversation panel logs **"Visitors left"** (8 s with nobody detected).
3. Come back in a **different costume** (a mask and a different shirt).

What happens: **nothing**. There's no greeting. Expected: "Someone's here after …s; checking whether they're new", then "new visitors (vision saw: …)", then a spoken greeting.

### Where to look
- `web/visitors.ts`: `VisitorTracker`. After `left`, a re-arrival within 90 s emits `returned` with `awayMs`.
  - Check that `update()` is still being called, and that people are detected. The label under the video shows "N detected (best X%)".
- `web/vision.ts`: MediaPipe `ObjectDetector`, `scoreThreshold` 0.3. A mask or close framing may hide the person.
- `web/director.ts`: `case "returned"` calls `ensureOpen()`, then `greet("returned", { awayMs })`.
- `web/engines/live.ts`: `greet()` calls `look(image, "returned", { previous: lastGroup })`.
  - If `sameGroup` comes back true, it stays silent (or says "welcome back" if they were away 45 s or more).
  - It emits a "same visitors as before (vision saw: …)" or "new visitors (…)" note.
- `server/openai.ts`: `describeFrame()`. For `returned`, the prompt asks for a "SAME:" or "NEW:" prefix. The terminal logs `[vision] returned in … ms: …`.

### Suggested approach
1. Run `npm run dev` and watch the terminal while the owner repeats the test.
2. Check the browser console (Cmd+Option+J) and the grey system lines in the Conversation panel.
3. Narrow it down to one of:
   - (a) the person isn't detected;
   - (b) the tracker emits nothing;
   - (c) the director or engine gets stuck, for example `ensureOpen` or a hung vision call;
   - (d) the vision model says SAME.

## Checks
- `npm test`: 54 tests passing.
- `npm run typecheck`
- `npm run build`
