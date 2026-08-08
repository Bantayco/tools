# fastenAIting — on-device ONNX classifier plan

Replace the Anthropic vision call with a small classifier that runs entirely
in the browser. Zero per-call cost, works offline, no user photos ever leave
the device. Training data comes from a Blender renderer we own end-to-end.

This document is the plan, not the implementation. It exists so we agree on
scope, label schema, evaluation protocol, and decision gates before spending
a week on it.

---

## 1. Goal and non-goals

**Goal.** A classifier the user's browser downloads once (≤ 20 MB), caches in
the service worker, and runs on-device in under a second per photo. It
identifies category, head shape, drive type, thread family, material, and
finish. It estimates diameter and length when a reference object is in frame.

**Non-goals.**
- No server-side inference. Cloudflare/Ollama/Replicate are all off the
  table for this path; we've decided elsewhere.
- No thread pitch / TPI classification. Too fine-grained; user edits.
- No SKU-level identification. Category × attributes only.
- No manufacturer or brand recognition.
- No detection of multiple fasteners in one photo — one fastener per frame.

**Success criterion for shipping.** ≥ 70% top-1 agreement with a held-out
set of ~200 real phone photos on the four highest-value fields (category,
head, drive, material). Length/diameter within ±20% when a coin or ruler is
in frame, no accuracy target when it isn't. Below 70% we ship Workers AI or
keep Anthropic; above 90% we ship as primary.

**Decision gate before we start training in earnest.** After Phase A (~2
days), if the sim2real gap on 20 real photos leaves us below 45%, we abort
the ONNX path and go back to hosted inference.

---

## 2. Label schema

Same fields the current AI prompt returns, adapted for a fixed multi-head
classifier. Each field is either a fixed-size softmax over enum values or a
regression over a normalized range.

| Field       | Head type   | Classes / range                                                                              |
|-------------|-------------|-----------------------------------------------------------------------------------------------|
| category    | softmax (8) | Screw, Bolt, Nut, Washer, Anchor, Rivet, Nail, Other                                          |
| head        | softmax (10)| Pan, Flat, Oval, Round, Truss, Button, Hex, Socket cap, Bugle, None                           |
| drive       | softmax (10)| Phillips, Slotted, Pozidriv, Torx, Square, Hex, External hex, Combination, None, Unknown     |
| thread      | softmax (8) | Coarse, Fine, Machine, Wood, Self-tapping, Sheet metal, None, Unknown                         |
| material    | softmax (7) | Steel, Stainless, Brass, Aluminum, Nylon, Zinc, Copper                                        |
| finish      | softmax (7) | Zinc-plated, Black oxide, Bright, Chrome, Galvanized, Painted, Unfinished                     |
| color_hint  | softmax (8) | silver, black, brass, gold, copper, chrome, white, other                                      |
| diameter_mm | regression  | Normalized to [0, 1] over [1.5 mm, 20 mm]; output un-normalized                               |
| length_mm   | regression  | Normalized to [0, 1] over [3 mm, 150 mm]; output un-normalized                                |
| has_ref     | sigmoid     | Confidence that a coin or ruler is visible; regressions only trusted above 0.7                |

Each softmax head also emits its argmax confidence. The client shows a
"Verify" hint when any headline field is below 0.6.

Output structure matches the existing form field names one-for-one so the
existing `applySpec` path in `app.js` works with zero change on the client.

---

## 3. Rendering pipeline (Blender)

The training data is entirely synthetic. Blender + Python + Cycles renders
every image; the label is what we asked it to render, so ground truth is
perfect.

### 3.1 Parametric assets

Each fastener family is a Python function that returns a Blender mesh.
Parameters are the same ones the classifier will predict.

```
make_screw(head_shape, drive_type, shank_diameter_mm, length_mm,
           thread_pitch_mm, tip_type, material_id)
make_bolt(same signature, defaults to hex head + external drive)
make_nut(shape='hex'|'wing'|'cap', size_mm)
make_washer(kind='flat'|'lock'|'fender', od_mm, id_mm)
make_anchor(kind='drywall'|'plastic'|'sleeve', size_mm)
make_rivet(kind='pop'|'solid', diameter_mm, grip_mm)
make_nail(kind='common'|'finishing'|'roofing', diameter_mm, length_mm)
```

Head shape is either a preset mesh (loaded from a small `.blend` library)
or generated procedurally. Drive recess is Boolean-cut into the head — a
handful of drive shapes total (cross, line, hex, star, square, cross+lines
for Pozidriv).

Threads are approximated with a helical modifier plus a triangular profile;
we don't need physically-accurate threads — visual pitch is what matters.

### 3.2 Materials (PBR)

Six PBR shaders authored once:
- Steel — mid roughness (0.25–0.55), slight anisotropy, no color
- Stainless — lower roughness (0.15–0.35), colder tint
- Zinc-plated — spectral variation ("rainbow oil slick" at grazing angles)
- Black oxide — very dark, high roughness (0.5–0.85)
- Brass — yellow-gold tint, varied roughness
- Galvanized — matte, mottled surface texture

Each material randomizes roughness within its band on every render. Every
5th render gets an added "wear" layer — dust, scratches, edge highlights,
occasional paint drip — because real fasteners are not showroom-clean.

### 3.3 Scene and lighting randomization

For every render:
- Camera at random spherical position around the fastener, biased toward
  "hand-held phone angles" (mostly 20–60° above horizon).
- Field of view sampled from a distribution matching phone cameras (60–75°).
- Random focus distance around the fastener; occasional slight defocus.
- HDR environment from a rotating pool of ~40 free HDRIs
  (Poly Haven — CC0). Random rotation.
- Optional secondary point light at random position/color to simulate
  workshop lighting.
- Ground plane with random PBR material (wood, concrete, metal, cardboard,
  cloth, tile, paper — 10 preset materials, sampled).

### 3.4 Background compositing

Half the renders composite the fastener onto a real-world background image
instead of the rendered ground plane. Backgrounds come from a curated pool
of ~500 Unsplash CC0 photos: workbenches, hardware trays, kitchen counters,
tile floors, wooden surfaces, hands holding hardware. Composited with a
soft shadow layer to avoid the "floating" look.

The counterintuitive rule: renders that look *worse* (weird lighting,
non-photorealistic backgrounds, extreme angles) improve real-world accuracy
more than photorealistic renders do. This is domain randomization —
overwhelming the network with nuisance variability so it learns invariance.

### 3.5 Reference-object augmentation

30% of renders include a reference object in the frame — random US or EU
coin models, or a ruler edge. These renders set `has_ref = 1`; the diameter
and length labels come from the actual mesh dimensions, so the model can
learn scale from co-visible reference objects.

### 3.6 Dataset size

- Total: 250,000 renders.
- Class balance: enforced at generation time (equal count per
  `category × head × drive` combination present in the enum).
- Split: 240k train, 5k validation (synthetic), 5k held-out (synthetic).
- Time: ~1 second per render on a mid-tier GPU (RTX 4070 class); ~72 GPU-
  hours total. Realistic on a $0.30/hr RunPod for ~$20, or on a home GPU
  over three overnight runs.

---

## 4. Real-photo evaluation set

Synthetic-only evaluation is a trap. We collect a small real set to score
against — this is the only real-image work in the plan.

- 200 photos, taken by us, of fasteners from a hardware drawer.
- Labeled by hand using the current form.
- Split by capture condition: 100 "clean" (single fastener, plain background,
  good light), 100 "wild" (hand-held, cluttered, mixed lighting).
- Never shown to the model during training. Only used for the sim2real
  measurement and the ship / don't-ship decision.

This is a one-day chore, but it's the only anchor to reality we have. Skip
it and we'll have a model that scores 95% on renders and 40% on the app.

---

## 5. Model architecture

Backbone: **MobileNetV3-Small (1.0×)**, 224×224 RGB input, pretrained on
ImageNet.

Heads: attach after the final pooling layer.
- 7 categorical heads (Linear → softmax over each field's classes).
- 2 regression heads (Linear → sigmoid → un-normalized to mm).
- 1 sigmoid head for `has_ref`.
- Total added parameters: ~50k.

Loss: weighted sum.
- Categorical: cross-entropy per head. Weights tuned so no single field
  dominates gradient. Initial weights all 1.0.
- Regression: SmoothL1 on the normalized value. Weight 0.5.
- `has_ref`: binary cross-entropy. Weight 0.3.
- Regression gated: if `has_ref = 0` in the label, the regression loss on
  that sample is zeroed. Prevents the model from learning to guess sizes
  from nothing.

Model size after INT8 quantization: ~4 MB. Well under budget.

---

## 6. Training pipeline

Framework: **PyTorch**. Lightning if we want speed, plain loop if we want
simplicity.

- Input pipeline: on-the-fly augmentation on top of the rendered images —
  random crop, horizontal flip, color jitter, motion blur, JPEG
  compression noise, occasional cutout. All conditioning that phone
  photos have that renders don't.
- Optimizer: AdamW, LR 3e-4, cosine schedule, 30 epochs, batch 64.
- Time on one RTX 4070: ~8 hours end-to-end. Cheaper on RunPod at ~$3.
- Fine-tuning phase 2 (optional, only after Phase A passes): 5 epochs at
  1e-5 on any real photos we've collected through the "AI got this wrong,
  here's the correction" feedback pathway (see § 10).

Checkpoints saved every epoch. Best checkpoint chosen by macro-F1 across
the categorical heads on the synthetic validation split.

---

## 7. Model export

- Export from PyTorch to ONNX with `opset_version=17`.
- Quantize to INT8 with ONNX Runtime's dynamic quantizer.
- Validate: run 100 held-out synthetic images through both the PyTorch and
  the quantized ONNX pipeline; assert argmax matches ≥ 99% and regression
  outputs differ by less than 0.02 in normalized space.
- Output file: `fastenaiting/models/fastener-v1.onnx` (~4 MB).
- A `models/fastener-v1.json` manifest ships alongside with:
  - schema version
  - class labels per head (index → string)
  - regression min/max for de-normalization
  - checksum of the ONNX bytes

---

## 8. Browser integration

Runtime: **onnxruntime-web** with the **WebGPU** execution provider,
falling back to WASM (SIMD + threads) when WebGPU is unavailable.

- Add-only file: `fastenaiting/classifier.js`. Exports
  `identifyOnDevice(imageDataUrl): Promise<Spec>`.
- The existing server function (`functions/api/fastenaiting/identify.js`)
  stays in place as a fallback. If the ONNX model is loaded and confidence
  passes a threshold, we use it and skip the network. Otherwise we fall
  through to the server call.
- Service worker changes:
  - Add `models/fastener-v1.onnx` and its manifest to `SHELL`.
  - Bump `SW_VERSION` so the cache reloads on first visit after ship.
  - Total shell size goes from ~120 KB to ~4 MB. Still acceptable for a
    one-time download.
- Model download strategy: **lazy on first identify** rather than at page
  load, so first paint isn't blocked. A tiny status pill shows "downloading
  identifier (4 MB)" once, then never again.
- Inference latency target: ≤ 800 ms on a 2020-era phone (Pixel 5, iPhone
  12) with WebGPU; ≤ 2 s on WASM fallback.
- Memory footprint: ~40 MB peak during inference. Well within mobile
  Safari's tab budget.

---

## 9. Rollout in the app

Order matters. Don't ship the classifier as primary until we've measured
it in the wild.

- **Stage 1 — dark mode.** Ship the classifier disabled by default; enable
  behind `?onnx=1` for our own testing. Every identify call in this stage
  runs BOTH pipelines and logs the disagreement to a lightweight endpoint.
- **Stage 2 — opt-in.** Setting in the Settings dialog: "Use on-device
  identifier (beta)". Anyone who flips it uses ONNX first, Anthropic on
  low confidence.
- **Stage 3 — default with fallback.** Once agreement crosses the shipping
  threshold, ONNX becomes the default; the network fallback only fires
  when the model returns low confidence across all categorical heads.
- **Stage 4 — remove Anthropic.** Only if Stage 3 holds for two months and
  the model has been fine-tuned on real corrections. Retain the server
  function file as a documented escape hatch; delete the key from the
  Pages secret list.

---

## 10. Feedback loop (fine-tuning corpus)

Any time a user edits an AI-populated field, we have gold-quality real
data. Opt-in only, minimum friction:

- Settings toggle: "Help improve the identifier (send corrections)". Off
  by default. Copy explains what's sent (photo + corrected spec) and what
  isn't (any identifier, any location, anything else).
- On correction, POST photo + before/after spec to a small write-only
  endpoint. Storage: Cloudflare R2 bucket. No user identifier — the
  correction is the data, not who made it.
- Corpus is used for Phase-2 fine-tuning every N thousand corrections.
- Retention: 12 months, then delete or aggregate.

This bakes a compounding loop: the more the tool is used, the better the
model gets. It also gives us the small real-labeled corpus we don't have
today.

---

## 11. Cost model

One-time:
- Model rendering compute: ~$20 on RunPod, or free on a home GPU over ~72h.
- Training compute: ~$3 on RunPod, or free on a home GPU over ~8h.
- Real-photo evaluation set: 200 photos, ~4 hours of your time.
- Development: ~2–4 weeks depending on how many sim2real iterations we go
  through.

Recurring:
- Inference: $0. Runs in the user's browser.
- R2 storage for the feedback corpus: pennies per month for the first year.
- Fine-tuning re-runs: ~$5 per run on RunPod, maybe quarterly.

Compare to Anthropic today: at ~$0.003 per identify call and 10k calls a
month, ~$30/mo forever. Break-even is instant.

---

## 12. Risks and mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Sim2real gap too wide (< 45% on real photos) | Medium | Phase-A abort gate before we spend real time. Fallback: keep Workers AI as the primary path. |
| Regressions on physical size (diameter/length) with no reference | High | Gate the regression outputs on `has_ref`. When missing, don't display estimates — only the categorical fields. |
| WebGPU coverage gaps on iOS Safari | Medium | WASM SIMD fallback works everywhere; benchmark it explicitly during Phase-A. |
| Model download hurts first-run experience | Low | Lazy-load on first identify with visible progress. It's ~4 MB, one time. |
| Blender renderer becomes a bespoke maintenance burden | Medium | Keep it small, scriptable, and reproducible. Every render seed is deterministic. Commit the renderer, not the renders. |
| Enum drift between aide, prompt, classifier | High | Single source of truth: derive the label schema, the manifest JSON, and the aide's constraint file from one YAML. Break the build if they diverge. |
| Feedback corpus becomes a legal/privacy issue | Medium | Opt-in only. Delete on request. Don't retain longer than 12 months. Documented in the aide as an invariant. |

---

## 13. Milestones

| Phase | Deliverable | Effort | Gate |
|-------|-------------|--------|------|
| A | Blender renderer, 5k images, tiny MobileNet trained on 3×3×3 combos, in-browser demo, 20 real-photo evaluation | 2 days | Real-photo top-1 ≥ 45% on category+head → continue |
| B | Full enum coverage, 250k renders, real training run, ONNX export, browser integration behind `?onnx=1` | 1 week | Real-photo top-1 ≥ 70% on category, head, drive, material → continue |
| C | Opt-in in Settings, feedback endpoint, fine-tuning script | 3 days | Weekly usage > 100 corrections → enough data for a re-train cycle |
| D | Default-on with fallback | 1 day | Two months of stable performance → remove Anthropic |

Total: roughly 2–3 weeks of engineering plus real-photo collection.

---

## 14. Aide changes

If we execute this, the aide picks up:

- **New CUJ**: `cuj_identify_on_device` — user identifies a fastener with
  no network round-trip. Tier: primary. Depends on `cuj_install_pwa` for
  the model to be cached.
- **New invariants**:
  - `inv_no_photo_bytes_leave_device` — stricter version of the current
    "no server persistence" invariant. Threat signal: any network request
    from an identify action.
  - `inv_model_shipped_versioned` — the ONNX file and its manifest carry
    matching version tags; the SW refuses to run a mismatched pair.
  - `inv_regression_gated_on_reference` — diameter/length are only shown
    to the user when `has_ref ≥ 0.7`.
- **New constraints**:
  - `con_classifier_size` — model + manifest total ≤ 20 MB.
  - `con_classifier_runtime` — inference runs via onnxruntime-web with
    WebGPU preferred, WASM fallback.
  - `con_feedback_opt_in` — the correction-feedback pathway is off by
    default and gated on explicit user consent.
- **Removed constraint** (eventually): `con_ai_via_pages_function` — only
  removed after Stage 4 completes. Until then, both paths coexist.
- **Existing black-box `delegates_to` edge** re-targets: `sc_camera_happy`
  currently delegates to Anthropic's opaque vision model; after Stage 3 it
  delegates to `fastener-v1.onnx`, which is our black box but with a
  measurable eval loop attached.

The `fastenaiting.vision.aide` child aide sketched in the parent's honest
gaps section becomes real here — the classifier has its own architectural
decisions (backbone, quantization, augmentation strategy), its own eval
metrics, and its own release cadence. It deserves its own spec once we
commit.

---

## 15. What we need from you before starting Phase A

- Confirm the label schema in § 2 matches what you want.
- Access to a machine with an NVIDIA GPU, OR $25 for RunPod credit.
- A drawer of fasteners for the 200-photo real-eval set. If you don't
  have one, we buy a hardware assortment (~$40).
- Approval to add `pytorch`, `onnx`, and `onnxruntime` to a `training/`
  subtree that ships to git but not to the deployed site.

Say the word on any of these and we start Phase A the same day.
