# Auto-resume capsule anchor — issue #67 evidence

Captured 2026-08-10 against the local dev server at 1440x900, on a real server thread.
Both runs drive the identical script: open the right panel, open the terminal drawer, close the
right panel, close the drawer. The only difference between them is the one file under test.

| File                                              | What it shows                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| `side-by-side.gif`                                | Both runs together, labelled. The quickest look.                  |
| `side-by-side.mp4`                                | Same, higher quality (1920x648).                                  |
| `before.mp4`                                      | Pre-fix build only, full resolution.                              |
| `after.mp4`                                       | Fixed build only, full resolution.                                |
| `still-side-by-side-both-open.png`                | Single frame, right panel **and** drawer open — the clearest one. |
| `still-before-right-panel.png`                    | Capsule stranded over the right panel's Agents card.              |
| `still-before-drawer.png`                         | Capsule stranded inside the terminal drawer.                      |
| `still-after-both.png` / `still-after-drawer.png` | The same states, fixed.                                           |

## How the "before" run was produced

`apps/web/src/coil/AutoResumeOverlay.tsx` was temporarily reverted to its `main` version, Vite
reloaded, and the run was recorded before restoring the fix. The capture asserted it was really
running the pre-fix build by reading the wrapper's inline styles — `width: ""`, `left: ""`,
`bottom: "212px"`, i.e. no measured horizontal placement — so these frames cannot be the fixed
build mislabelled.

## What to look for

- **Right panel opens.** Before: the capsule keeps its old right edge and ends up floating over the
  panel, 352px past the composer. After: it narrows with the chat column and stays flush with the
  composer card's right edge.
- **Drawer opens.** Before: the composer rises by the drawer's height (280px) and the capsule does
  not move at all, ending up inside the terminal. After: it rises with the composer, holding a
  constant 8px gap.

Measured across baseline, right panel, drawer, both, maximized panel, narrow-window sheet and
sidebar collapse: horizontal drift `0`, vertical gap `8` in every state.

The raw frame sequences (`frames-before/`, `frames-after/`, 104 PNGs each) are not committed —
they are excluded via `.git/info/exclude` and only exist in the working tree that recorded them.
