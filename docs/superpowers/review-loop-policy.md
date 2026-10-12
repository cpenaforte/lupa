# Review-loop policy (standing controller rule)

Date: 2026-10-12. Source: F13 plan loop ran 21 rounds; audit showed the loop was
self-sustaining (each fix adds new text surface for new nits) and churn had become
the top defect source (the only post-round-11 Critical was introduced by a rewrite).

## Rule

- **Maximum 3 review rounds per artifact** (spec or plan), reviewer included.
- **Round 3 is blocking-only**: Critical/Important verdicts only. Minor wording,
  naming, and fixture-content findings after round 2 are batched into one fix pass,
  not looped.
- **After round 3, the controller triages, fixes, and closes by ruling**, logging
  residual risk and where the per-task gates cover it. No round 4+ without explicit
  owner approval.
- **One finding, one fix, one verification**: a fix that introduces a new defect
  counts against the round budget like any other finding (it does not restart it).
- **Reviewer instructions must carry the bar**: every dispatch after round 1 says
  "say CLEAN and stop — do not manufacture findings" (already standard) AND, from
  round 3, "blocking-only".

## Why

Findings-per-round decay is normal and expected: rounds 1–2 catch design defects;
later rounds catch wording. Past data: F09 spec closed in 4, trust-boundaries in
4–5, native-providers in 5 — all before this rule. F13's 21-round plan loop is the
case that must not repeat.
