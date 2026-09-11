// Entry point referenced by index.html — composition only, real bootstrap
// lives in __main.tsx (template-managed).
//
// A returning managed sign-in has to be completed once, before routes render.
// That await CANNOT live here: __main.tsx mounts React as a side effect of
// being evaluated, and static imports are hoisted, so the mount would always
// win the race against a top-level await. It is handled by <ManagedAuthGate>
// inside the tree instead — see components/managed-auth-gate.tsx.
import "./__main";
