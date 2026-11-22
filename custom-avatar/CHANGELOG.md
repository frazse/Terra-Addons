# Changelog — Custom 3D Avatar

## 0.1.0

- Experimental WebGPU rigged `.glb` avatar importer and live Biketerra skeleton retargeter (stored locally in IndexedDB).
- Automatic bone mapping across ValveBiped/HL2, Mixamo, Unreal/Fortnite, Super Smash Bros., Nintendo/BotW, VRM/Rigify, and unnamed skeletons (`Auto-Topo` fallback), plus detached secondary armature anchoring (e.g. separate hair skins).
- Live Biketerra spine/head pose retargeting, 2-bone leg & arm IK with zero-twist shoulder swing, reach-aware auto-scale and aero lean, overhand brake-hood grip, and bind-curl-aware finger wrapping.
- Automatic hiding of unskinned scene backdrops/handheld props with clickable per-part visibility chips saved per model.
- Real Biketerra shadow-map casting via `pools.misc` (`shadowOnly: true`), with planar shadow fallback.
