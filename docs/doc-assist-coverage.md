# Documentation-assist coverage

Which BHW charge-master codes have a documentation-assist entry (`engine/data/doc-assist.json`).
The **scrub engine** already covers every code with NCCI/MUE/rule data; this table tracks the
note↔code documentation layer, which is built from real guidance code-by-code.

**Coverage: 103 / 137 charge-master codes.** Regenerate with `node tools/coverage.mjs`.

| Program | Covered | Codes still needing a guide |
|---|---|---|
| CharmEd Minds | 10/11 | 96125 |
| Flow Vascular Stabilization | 11/11 | — |
| Mind & Mood | 24/25 | G0323 |
| Population Health (CCM) | 20/43 | 0403T, G0108, G0109, 97802, 97803, 97804, G0270, G0271, G9873, G9874, G9875, G9876, G9877, G9878, G9879, G9880, G9881, G9882, G9883, G9884, G9885, G9890, G9891 |
| Primary Care (BHW) | 38/47 | 99211, 90460, 94070, 94150, 94200, 94664, G0443, G0447, G0446 |
