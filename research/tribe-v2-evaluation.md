# TRIBE v2 — Model Evaluation

**Date**: 2026-04-01
**Work Item**: W-836
**Status**: Done

## Overview

TRIBE v2 (Transformer for Representing and Interpreting Brain Encoding) is a multimodal brain encoding model by Meta/Facebook Research. It predicts fMRI brain responses on the cortical surface (~20k vertices, fsaverage5 mesh) given video, audio, or text input.

- **HuggingFace**: `facebook/tribev2`
- **GitHub**: `facebookresearch/tribev2`
- **License**: CC-BY-NC-4.0 (non-commercial only)
- **Released**: ~March 26, 2026

## Architecture

Unified Transformer combining three backbone encoders:

| Modality | Backbone | Estimated Size |
|----------|----------|---------------|
| Text | LLaMA 3.2-3B | ~6 GB |
| Video | V-JEPA2 (ViT-G, FPC64-256) | ~2-4 GB |
| Audio | Wav2Vec-BERT 2.0 | ~600 MB |
| TRIBE v2 head | Transformer brain encoder | 709 MB |

Trained on 1,000+ hours of brain data from 700+ subjects. Covers 70,000 brain regions (70x improvement over v1). Outputs are offset by 5 seconds to account for hemodynamic delay.

## Size & Storage

| Component | Size |
|-----------|------|
| TRIBE v2 checkpoint (`best.ckpt`) | 709 MB |
| LLaMA 3.2-3B (gated, requires HF auth) | ~6 GB |
| V-JEPA2 ViT-G | ~2-4 GB |
| Wav2Vec-BERT 2.0 | ~600 MB |
| Python deps (PyTorch, etc.) | ~2-3 GB |
| Feature cache (per-video) | variable |
| **Total estimated disk** | **~12-15 GB** |

Backbone models are NOT included in the 709 MB checkpoint. They are downloaded separately on first use via the `neuralset` library.

## Environment Requirements

### Software

- Python >= 3.11
- PyTorch >= 2.5.1, < 2.7
- Key deps: torchvision, transformers, x_transformers, einops, moviepy, huggingface_hub, spacy, neuralset, neuraltrain
- Optional: nibabel, nilearn, pyvista (brain visualization), lightning + wandb (training)

### Hardware — Inference

| Resource | Minimum (CPU) | Recommended (GPU) |
|----------|--------------|-------------------|
| RAM | 16 GB | 32 GB |
| VRAM | N/A | 12+ GB (RTX 3060+) |
| GPU | Not required (slow) | NVIDIA CUDA-capable |
| Disk | 15 GB free | 20 GB free |

CPU fallback supported (`cuda` if available, else `cpu`). Memory-mapped loading (`mmap=True`) helps with large checkpoints.

### macOS Feasibility

- **Apple Silicon (M1/M2/M3/M4)**: Possible via MPS backend. 32 GB+ unified memory recommended. 16 GB is tight.
- **Intel Mac**: CPU-only, very slow.
- **Best experience**: Linux with NVIDIA GPU (12+ GB VRAM).

### Authentication

LLaMA 3.2-3B is a gated model. Requires:
1. HuggingFace account
2. Accept Meta's LLaMA 3.2 license agreement
3. `huggingface-cli login`

## Quick Start

```bash
git clone https://github.com/facebookresearch/tribev2.git
cd tribev2
pip install -e .            # inference only
pip install -e ".[plotting]" # with brain visualization
huggingface-cli login

python -c "
from tribev2 import TribeModel
model = TribeModel.from_pretrained('facebook/tribev2', cache_folder='./cache')
df = model.get_events_dataframe(video_path='path/to/video.mp4')
preds, segments = model.predict(events=df)
print(preds.shape)  # (n_timesteps, n_vertices)
"
```

A Colab demo notebook is available for zero-setup experimentation.

## Assessment

### Strengths

- First model to unify video, audio, and text brain encoding at scale
- 70k brain regions, 700+ subjects
- Fully open-sourced (code, weights, demo)
- Matches population-level brain activity better than most real scans
- Clean Python API (`TribeModel.from_pretrained()`)

### Limitations

- Non-commercial license (CC-BY-NC-4.0)
- ~12-15 GB total footprint from backbone models
- HuggingFace auth required for gated LLaMA access
- Hardware requirements not well-documented by Meta
- `neuralset` and `neuraltrain` are Meta-internal packages with limited docs

## GPU Selection: NVIDIA vs AMD

### Does GPU brand matter?

Yes. TRIBE v2 depends on PyTorch with CUDA. The entire stack (PyTorch, torchvision, transformers, the `neuralset` library) is built and tested against NVIDIA CUDA. AMD support exists through ROCm but is secondary.

### Comparison

| Factor | NVIDIA (CUDA) | AMD Radeon (ROCm) |
|--------|--------------|-------------------|
| PyTorch support | First-class, all versions | Supported but narrower hardware list |
| TRIBE v2 tested on | Yes (assumed) | No evidence of testing |
| Driver stability | Mature | Improving, occasional issues |
| Setup complexity | Plug and play | Manual ROCm install, kernel compatibility |
| Supported cards | All CUDA-capable (GTX 900+) | RX 7900 XTX/XT, some older Pro cards |
| Consumer mid-range | Well supported (RTX 4060-4090) | Inconsistent (RX 7600/7800 XT ROCm gaps) |

### VRAM requirements for TRIBE v2

All backbone models load into VRAM during inference:

| Component | VRAM (FP16) |
|-----------|-------------|
| LLaMA 3.2-3B | ~6 GB |
| V-JEPA2 ViT-G | ~2-4 GB |
| Wav2Vec-BERT 2.0 | ~600 MB |
| TRIBE v2 head | ~1.4 GB |
| **Total peak** | **~10-12 GB** |

Quantization could reduce this but is not documented for TRIBE v2.

### Recommended GPUs

| Budget | GPU | VRAM | Notes |
|--------|-----|------|-------|
| Low | RTX 3060 12GB | 12 GB | Minimum for full model, tight |
| Mid | RTX 4070 Ti Super 16GB | 16 GB | Comfortable headroom |
| High | RTX 4090 24GB | 24 GB | Room for batching and caching |
| Used | RTX 3090 24GB | 24 GB | Best value per GB |
| AMD (if owned) | RX 7900 XTX 24GB | 24 GB | Works via ROCm, expect setup friction |

### RX 9060 (RDNA 4) assessment

The RX 9060 (Navi 44, RDNA 4) is expected in 8 GB and 16 GB VRAM variants.

- **8 GB**: Not viable. TRIBE v2 peaks at ~10-12 GB VRAM.
- **16 GB**: Fits the model, but with minimal headroom for batching or caching.
- **ROCm risk**: RDNA 4 is new silicon. ROCm has historically lagged behind new AMD architectures by months — RDNA 3 (RX 7000) had delayed and unstable PyTorch support at launch. Until AMD officially adds RDNA 4 to the ROCm supported hardware list, PyTorch GPU acceleration may not work at all.
- **Price/value**: If priced similarly to a used RTX 3090 24GB, the RTX 3090 is the safer choice — more VRAM, proven CUDA support, no driver gamble.

Wait for confirmed ROCm RDNA 4 support and real-world PyTorch benchmarks before purchasing for ML workloads.

### Recommendation

Use NVIDIA. The TRIBE v2 codebase, its dependencies (PyTorch, transformers, neuralset), and Meta's own testing all target CUDA. AMD Radeon can technically work through ROCm + PyTorch, but there is no evidence Meta tested TRIBE v2 on it, and debugging compatibility issues wastes time. If you already own a high-VRAM AMD card, it's worth trying — but for a new purchase, NVIDIA is the lower-risk choice.

For the 12 GB VRAM minimum listed in the evaluation above, an RTX 3060 12GB is the entry point. An RTX 3090 (used) or RTX 4070 Ti Super gives a more comfortable margin.

## ROCm Setup Guide (AMD GPU + PyTorch)

Step-by-step guide for setting up ROCm to run TRIBE v2 on an AMD Radeon GPU. Tested path is Ubuntu 22.04 or 24.04 with RDNA 3 (RX 7900 series). RDNA 2 and older GCN cards have partial support.

### Step 1 — Verify GPU compatibility

Check that your GPU is on the ROCm supported hardware list before proceeding.

**Supported (as of ROCm 6.x)**:
- RX 7900 XTX, RX 7900 XT, RX 7900 GRE
- RX 7600 (limited, community support)
- Pro W7900, W7800
- RDNA 4 (RX 9000 series): not yet confirmed

**Not supported**: RX 6000 series and older are unofficially usable but not tested by AMD.

```bash
# Check your GPU
lspci | grep -i amd
# Example output: VGA compatible controller: AMD/ATI Navi 31 [Radeon RX 7900 XTX]
```

### Step 2 — OS preparation (Ubuntu 22.04 or 24.04)

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install kernel headers (ROCm builds kernel modules)
sudo apt install -y linux-headers-$(uname -r)

# Add yourself to render and video groups (required for GPU access)
sudo usermod -aG render,video $USER

# Reboot to apply group changes
sudo reboot
```

### Step 3 — Install ROCm

Use AMD's official package repository. Do not install from random PPAs.

```bash
# Import AMD GPG key
wget https://repo.radeon.com/rocm/rocm.gpg.key -O - | \
  gpg --dearmor | sudo tee /etc/apt/keyrings/rocm.gpg > /dev/null

# Add ROCm repo (replace 6.3 with latest stable version)
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/rocm.gpg] \
  https://repo.radeon.com/rocm/apt/6.3 jammy main" | \
  sudo tee /etc/apt/sources.list.d/rocm.list

# Pin ROCm packages to prefer AMD's repo
echo -e 'Package: *\nPin: release o=repo.radeon.com\nPin-Priority: 600' | \
  sudo tee /etc/apt/preferences.d/rocm-pin-600

sudo apt update
sudo apt install -y rocm-hip-runtime rocm-hip-sdk rocm-dev
```

### Step 4 — Verify ROCm installation

```bash
# Check ROCm version
cat /opt/rocm/.info/version

# Verify GPU is detected
rocminfo | grep -i "name"
# Should show your GPU (e.g., gfx1100 for RX 7900 XTX)

# Quick compute test
rocm-smi
# Should display GPU temp, utilization, VRAM usage
```

If `rocminfo` does not list your GPU, check:
- Kernel version compatibility (ROCm 6.x needs kernel 5.15+ or 6.x)
- Group membership (`groups` should show `render` and `video`)
- Secure Boot may block unsigned kernel modules — disable in BIOS if needed

### Step 5 — Set environment variables

```bash
# Add to ~/.bashrc or ~/.zshrc
export ROCM_HOME=/opt/rocm
export PATH=$ROCM_HOME/bin:$PATH
export LD_LIBRARY_PATH=$ROCM_HOME/lib:$LD_LIBRARY_PATH

# GPU architecture override (needed for some consumer cards)
# gfx1100 = RX 7900 XTX/XT, gfx1101 = RX 7800 XT/7700 XT, gfx1102 = RX 7600
export HSA_OVERRIDE_GFX_VERSION=11.0.0  # adjust for your card

source ~/.bashrc
```

The `HSA_OVERRIDE_GFX_VERSION` variable is sometimes required for consumer Radeon cards that aren't in ROCm's official list. Without it, PyTorch may fail to detect the GPU.

### Step 6 — Install PyTorch with ROCm support

Do NOT install the default PyTorch (it ships with CUDA). Use the ROCm-specific build.

```bash
# Create a virtual environment
python3 -m venv ~/tribe-rocm
source ~/tribe-rocm/bin/activate

# Install PyTorch for ROCm (check pytorch.org for latest command)
# As of PyTorch 2.5.x with ROCm 6.3:
pip install torch torchvision torchaudio \
  --index-url https://download.pytorch.org/whl/rocm6.3
```

### Step 7 — Verify PyTorch sees the GPU

```bash
python3 -c "
import torch
print('PyTorch version:', torch.__version__)
print('ROCm available:', torch.cuda.is_available())  # yes, it uses cuda API
print('Device count:', torch.cuda.device_count())
print('Device name:', torch.cuda.get_device_name(0))
print('VRAM:', round(torch.cuda.get_device_properties(0).total_mem / 1e9, 1), 'GB')
"
```

Expected output (RX 7900 XTX example):
```
PyTorch version: 2.5.1+rocm6.3
ROCm available: True
Device count: 1
Device name: AMD Radeon RX 7900 XTX
VRAM: 24.0 GB
```

If `torch.cuda.is_available()` returns `False`:
- Confirm `rocminfo` shows your GPU (Step 4)
- Check `HSA_OVERRIDE_GFX_VERSION` is set (Step 5)
- Ensure you installed the ROCm PyTorch build, not the default CUDA one (`pip show torch` should show `+rocm` in version)

### Step 8 — Install TRIBE v2

```bash
git clone https://github.com/facebookresearch/tribev2.git
cd tribev2
pip install -e .
pip install -e ".[plotting]"  # optional: brain visualization

# HuggingFace auth for gated LLaMA 3.2-3B
huggingface-cli login
```

### Step 9 — Test inference

```python
from tribev2 import TribeModel

model = TribeModel.from_pretrained('facebook/tribev2', cache_folder='./cache')
df = model.get_events_dataframe(video_path='path/to/test_video.mp4')
preds, segments = model.predict(events=df)
print(preds.shape)
```

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `torch.cuda.is_available()` is False | Wrong PyTorch build or missing ROCm | Reinstall with `--index-url .../rocm6.3` |
| `hipErrorNoBinaryForGpu` | GPU arch not recognized | Set `HSA_OVERRIDE_GFX_VERSION` |
| Segfault on model load | ROCm/kernel version mismatch | Match ROCm version to kernel (check AMD docs) |
| OOM on inference | Not enough VRAM | Use `PYTORCH_HIP_ALLOC_CONF=expandable_segments:True` |
| Slow inference (CPU-like speeds) | Fallback to CPU silently | Check `torch.cuda.is_available()` and device placement |
| `neuralset` download fails | Network or HF auth issue | Check `huggingface-cli whoami`, accept LLaMA license |
| Secure Boot blocks `amdgpu` module | Unsigned kernel module | Disable Secure Boot in BIOS |

### Real-world ROCm experience (community reports)

The documented steps look straightforward, but community experience (r/LocalLLaMA, r/AMD, HackerNews, ML forums) paints a rougher picture.

**Setup time**: 2-8 hours typical, vs ~30 minutes for NVIDIA CUDA. Periodic breakage on upgrades.

**Common real-world issues**:

1. Consumer RDNA 3 GPUs require `HSA_OVERRIDE_GFX_VERSION` hack — officially undocumented, fragile
2. ROCm + PyTorch + Python + kernel version combinations are trial-and-error; upgrading one can break others
3. Linux-only (Ubuntu most reliable); Windows has no ML support, Fedora/Arch need extra work
4. Performance reaches ~60-80% of equivalent NVIDIA hardware; some ops silently fall back to CPU
5. Error messages are cryptic with less community knowledge to draw from
6. Flash attention support arrived late and remains less mature than CUDA equivalent

**Mitigations**:

- **Docker**: ROCm PyTorch containers are the most reliable path, bypassing most bare-metal compatibility issues
- **Pin versions**: once a working ROCm + PyTorch combo is found, do not upgrade without testing
- **RX 7900 XTX**: has the most community knowledge accumulated; other RDNA 3 cards have less coverage

**Honest setup comparison**:

| Factor | NVIDIA CUDA | AMD ROCm |
|--------|------------|----------|
| Initial setup | ~30 min | 2-8 hours |
| Breaks on upgrade | Rare | Frequent |
| Community support | Extensive | Limited |
| First-try success | Usually | Rarely |
| Recommended path | Bare metal | Docker container |

### ROCm version compatibility matrix

| ROCm | PyTorch | Ubuntu | Kernel | RDNA 3 | RDNA 4 |
|------|---------|--------|--------|--------|--------|
| 6.0 | 2.3-2.4 | 22.04 | 5.15+ | Yes | No |
| 6.1 | 2.4-2.5 | 22.04 | 5.15+ | Yes | No |
| 6.2 | 2.5 | 22.04/24.04 | 5.15+/6.x | Yes | No |
| 6.3 | 2.5-2.6 | 22.04/24.04 | 6.x | Yes | TBD |

Always check the [ROCm installation docs](https://rocm.docs.amd.com/projects/install-on-linux/en/latest/) and [PyTorch get-started page](https://pytorch.org/get-started/locally/) for the latest compatible versions.

## Sources

- [facebook/tribev2 on HuggingFace](https://huggingface.co/facebook/tribev2)
- [facebookresearch/tribev2 on GitHub](https://github.com/facebookresearch/tribev2)
- [MarkTechPost article](https://www.marktechpost.com/2026/03/26/meta-releases-tribe-v2-a-brain-encoding-model-that-predicts-fmri-responses-across-video-audio-and-text-stimuli/)
- [Colab Demo](https://colab.research.google.com/github/facebookresearch/tribev2/blob/main/tribe_demo.ipynb)
