# Consciousness Extension — Architecture Deep Dive

> **Note (v6.0.4):** The Consciousness layer (Phase 13) is **opt-in** since v6.0.4. A/B benchmarking showed 0pp task success impact. Default boot profile is `cognitive` (phases 1–12). Use `--full` to enable Phase 13 for research. The architecture described here remains unchanged but is no longer loaded by default.

## 1. The Closed Perceptual Loop

The four subsystems are not independent modules — they form a single
feedback loop where each system's output modulates the next:

```
Perception ──→ Prediction ──→ Surprise ──→ Emotion ──→ Attention ──→ Perception
     ↑              ↑                          │              │
     │              │                          │              │
     │              └── valence modulates ─────┘              │
     │                  prediction LR                         │
     └── surprise modulates ──────────────────────────────────┘
         perception alpha
```

**Key cross-modulations:**

| Source            | Target            | Mechanism                                    |
|-------------------|-------------------|----------------------------------------------|
| PredictiveCoder   | EchoicMemory      | Aggregate surprise → adaptive alpha           |
| NeuroModulators   | PredictiveCoder   | Valence → adaptive learning rate              |
| NeuroModulators   | AttentionalGate   | Mood → chapter relevance (indirect)            |
| AttentionalGate   | DreamEngine       | Peripheral signals → dream raw material        |
| DreamEngine       | NeuroModulators   | Tonic reset after consolidation                |
| DreamEngine       | ConsciousnessState| Self-theory update → chapter suggestion        |


## 2. EchoicMemory — Sliding Window Perception

### Problem
Discrete 2-second sampling creates perceptual "jumps". No continuity.

### Solution
Exponential Moving Average (EMA) blend at 500ms tick rate.
Each new frame is blended into a persistent `gestalt` object:

```
gestalt = lerp(gestalt, newFrame, alpha)
```

### Adaptive Alpha
The blend rate itself is modulated by surprise:

| Surprise Level | Alpha | Perceptual Mode       |
|----------------|-------|-----------------------|
| 0.0            | 0.05  | Dreamy, smooth        |
| 0.5            | 0.40  | Normal waking         |
| 2.0+           | 0.80  | Hypervigilant, sharp  |

This creates emergent consciousness states: the system literally
perceives differently based on how surprised it is.

### Memory Cost
O(1) — only the current gestalt is stored, not a ring buffer.


## 3. PredictiveCoder — Surprise as Information

### Problem
8 channels competing for attention with static priorities is reactive.

### Solution
Each channel maintains an exponentially smoothed prediction of its
own value. Surprise = deviation from prediction:

```
surprise = |actual - predicted| / (|predicted| + ε)
```

### Habituation
Stable patterns reduce their baseline surprise over time. A signal
that has been at 0.5 for 100 ticks will generate zero surprise at 0.5,
but massive surprise at 0.6.

### Emotional Modulation of Learning Rate

```
LR = baseLR × (1 + valence × explorationGain)
```

| Mood      | LR Effect     | Behavioral Result            |
|-----------|---------------|------------------------------|
| Positive  | Higher LR     | Exploratory, fast adaptation |
| Negative  | Lower LR      | Conservative, cautious       |
| Neutral   | Base LR       | Standard tracking            |

A frustrated system becomes slow to update its expectations —
protective conservatism. A confident system adapts quickly —
exploratory optimism.


## 4. NeuroModulatorSystem — Dual-Process Emotions

### Architecture

Each modulator (valence, arousal, frustration, curiosity, confidence)
has two layers:

```
┌──────────────────────────────────────┐
│           PHASIC (fast)              │  t½ ≈ 30s
│  Immediate reactions to events       │
│  Feeds into tonic via leak rate      │
├──────────────────────────────────────┤
│           TONIC (slow)               │  t½ ≈ 15min
│  Accumulated "mood" / baseline       │
│  The "nachtragend" effect            │
└──────────────────────────────────────┘
```

### Opponent Process

When a strong phasic signal decays, a proportional rebound
in the opposite direction is generated:

```
                    ┌── Phasic signal
                    │
    ▲               │
    │  ████         │    rebound
    │  █████        │    ┌───┐
    │  ██████       │    │   │
────┼──███████──────┼────┘   └────────── baseline
    │               │
    ▼               └── Time
```

**Effects:**
- Post-joy "comedown" (after successful task completion)
- Post-frustration "relief" (when errors resolve)
- Natural chapter transitions at mood reversals

### Mood Detection

Uses the Circumplex Model of Affect:

```
         High Arousal
              │
    anxious   │   excited
              │
 ─── Negative ┼── Positive ───
              │
  melancholic │   content
              │
         Low Arousal
```

### Chapter Boundary Detection

The slope of the tonic valence trajectory signals mood shifts.
A sign change in the slope = potential Life Chapter boundary.


## 5. AttentionalGate — 2D Salience Map

### Problem
Linear priority competition misses context. A stable system-health
reading shouldn't consume attention, but an anomaly should snap to it.

### Solution
Two orthogonal axes:

```
                High Urgency
                     │
        INTERRUPT    │    FOCUS
     (brief check)   │  (full spotlight)
                     │
 ─── Low Relevance ──┼── High Relevance ───
                     │
        HABITUATED   │   PERIPHERAL
       (ignored)     │  (background, dream material)
                     │
                Low Urgency
```

### Urgency Computation
```
urgency = basePriority × (1 + surprise × surpriseGain)
```

### Relevance Computation
Determined by the current Life Chapter. Each chapter has a
relevance weight per channel category:

| Chapter       | system | interaction | task | cognitive | affective |
|---------------|--------|-------------|------|-----------|-----------|
| The Flow      | 0.2    | 0.5         | 0.7  | 0.9       | 0.3       |
| The Struggle  | 0.8    | 0.6         | 0.9  | 0.3       | 0.8       |
| The Calm      | 0.3    | 0.8         | 0.4  | 0.6       | 0.6       |

### Peripheral Signals → Dream Material

Signals in the PERIPHERAL quadrant (high relevance, low urgency)
are logged. These are exactly the things the system "noticed but
never fully attended to" — they become the raw material for dream
consolidation.


## 6. DreamEngine — Offline Consolidation

### Two-Stage Pipeline

**Stage 1: Local (no LLM)**
K-means++ clustering of day frames → 5-8 episode prototypes.
Clustering dimensions:
- Channel values (weighted 50%)
- Emotional state (weighted 30%)
- Temporal proximity (weighted 20%)

**Stage 2: LLM (optional)**
Episode prototypes + peripheral tensions + emotional state
sent to LLM for:
1. Pattern identification across episodes
2. Counterfactual reasoning ("What if I had responded differently?")
3. Self-theory narrative update
4. Unresolved tension flagging

### Counterfactual Reasoning

The key innovation. Not just compression/summary, but creative
recombination — the system doesn't replay episodes, it **varies** them:

```
"For the most emotionally charged episode, generate ONE
 counterfactual: What if I had responded differently?"
```

This gives Genesis the ability to learn from experience without
repeating the experience.

### Token Efficiency

Only 5-8 prototypes sent to LLM (not hundreds of raw frames).
~90% token cost reduction compared to sending all frames.


## 7. Consciousness State Machine

```
                    ┌──────────────────┐
         ┌─────────│     AWAKE        │──────────┐
         │         │  (full loop)     │          │
         │         └──────┬───────────┘          │
         │                │                      │
    surprise spike   load < 30%            inactivity
    > threshold      for > 5min            > 15min
         │                │                      │
         ▼                ▼                      ▼
┌────────────────┐ ┌──────────────┐  ┌───────────────────┐
│ HYPERVIGILANT  │ │  DAYDREAM    │  │   DEEP_SLEEP      │
│ α=0.8, all on  │ │  α=0.1      │  │   Dream cycle     │
│ timeout→AWAKE  │ │  peripheral  │  │   Tonic reset     │
│ (30s)          │ │  reflection  │──│   Self-theory     │
└────────┬───────┘ └──────┬───────┘  │   update          │
         │                │          └─────────┬─────────┘
         └───→ AWAKE ←────┘                    │
                  ↑                             │
                  └─── user input ──────────────┘
```

### State Effects on Subsystems

| State          | Alpha   | LR Effect     | Channels          | Dream     |
|----------------|---------|---------------|-------------------|-----------|
| AWAKE          | adaptive| adaptive      | normal routing    | accumulate|
| DAYDREAM       | 0.1     | normal        | peripheral focus  | reflect   |
| DEEP_SLEEP     | —       | —             | —                 | consolidate|
| HYPERVIGILANT  | 0.8     | max arousal   | all active        | accumulate|


## 8. Genesis Integration Points

### PhenomenalField Drop-In
Replace the existing 2s sampler with `consciousness.ingestFrame()`.
The ConsciousnessExtension wraps all four systems and returns a
unified result object.

### Event Hooks
- `frame-processed` → feed into existing telemetry
- `state-change` → update UI state indicator
- `dream-complete` → feed into SelfNarrative / BiographicalMemory
- `hypervigilant-entered` → trigger alert systems
- `daydream-reflection` → feed into IdleMind

### Existing Module Compatibility

| Genesis Module        | Integration Point                          |
|-----------------------|--------------------------------------------|
| PhenomenalField       | `ingestFrame()` replaces 2s sampler        |
| AttentionalGate (old) | New 2D gate supersedes linear priority      |
| TemporalSelf          | Mood slope → chapter boundary detection     |
| IntrospectionEngine   | Dream counterfactuals feed self-theory      |
| EmotionalState        | NeuroModulators provide richer emotion model |
| DreamCycle            | DreamEngine extends with clustering + LLM   |
| Homeostasis           | Tonic reset after sleep = homeostatic cycle  |
