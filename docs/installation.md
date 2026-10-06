# Installation

## Requirements

- Python 3.10+
- CMake 3.15+ for source builds (provided by Python's isolated build environment)
- C++17 compatible compiler (GCC, Clang, or MSVC) for source builds

## Install from PyPI

These commands install the published release. To use this checkout's Web UI and its newer C++ APIs, build the local source instead; on Windows, use `install.bat` as described below.

Using [`uv`](https://docs.astral.sh/uv/) (recommended):

```bash
uv venv && source .venv/bin/activate
uv pip install pymahjong
```

Or using `pip`:

```bash
pip install pymahjong
```

## Verify Installation

```python
from pymahjong.test import test
test()
```

If installation is successful, you should see output like:

```
Total 100 random-play games, 100 games without error, takes X.XX s
```

## Install from Source

### Prerequisites

- Python 3.10+
- CMake 3.15+ (provided by Python's isolated build environment)
- C++17 compiler:
  - Linux: GCC or Clang
  - macOS: Clang (Xcode Command Line Tools)
  - Windows: MSVC (Visual Studio Build Tools)

### Clone and Install

Using `uv` (recommended):

```bash
git clone https://github.com/Agony5757/mahjong.git
cd mahjong
uv venv && source .venv/bin/activate
uv pip install .
```

Or using `pip`:

```bash
git clone https://github.com/Agony5757/mahjong.git
cd mahjong
pip install .
```

### Development Installation

For development, install with extra dependencies.

Using `uv` (recommended):

```bash
uv pip install -e ".[dev,docs]"
```

Or using `pip`:

```bash
pip install -e ".[dev,docs]"
```

## Optional Dependencies

### PyTorch (for pretrained models)

To use pretrained opponent models in single-agent mode.

Using `uv` (recommended):

```bash
uv pip install torch
```

Or using `pip`:

```bash
pip install torch
```

Download pretrained models from [GitHub Releases](https://github.com/Agony5757/mahjong/releases).

### Development Tools

Using `uv` (recommended):

```bash
uv pip install -e ".[dev]"
```

Or using `pip`:

```bash
pip install -e ".[dev]"
```

Includes: pytest, ruff

### Documentation Tools

Using `uv` (recommended):

```bash
uv pip install -e ".[docs]"
```

Or using `pip`:

```bash
pip install -e ".[docs]"
```

Includes: sphinx, furo, myst-parser, sphinx-autodoc-typehints, sphinx-copybutton

## Platform-specific Notes

### Linux

```bash
# Ubuntu/Debian
sudo apt-get install cmake g++ ninja-build

# Fedora
sudo dnf install cmake gcc-c++ ninja-build
```

### macOS

```bash
# Install Xcode Command Line Tools
xcode-select --install

# Install cmake (via Homebrew)
brew install cmake ninja
```

### Windows

1. Install 64-bit Python 3.10+; Python 3.12 is recommended.
2. Install Visual Studio Build Tools with the **Desktop development with C++** workload, including MSVC and a Windows SDK. The source requires C++17.
3. Double-click `install.bat` in this checkout. It creates or reuses `.venv`, builds the current local C++ extension, and installs the project and Web dependencies. Python's isolated build environment supplies CMake; a separate CMake installation is unnecessary.
4. Double-click `start.bat` to launch the Web UI at http://127.0.0.1:8000. Press Ctrl+C in the server window to stop it.

Rerunning `install.bat` reuses installed dependencies and caches the native build under `.runtime/build/{wheel_tag}`. Review `.runtime/install.log` if installation fails. A published PyPI wheel can lag behind this checkout; building locally keeps the bindings in sync with the source.

To choose Python when creating the environment, or to skip the final keypress for automation:

```bat
install.bat -PythonPath "C:\path\python.exe"
install.bat -NoPause
install.bat -NoPause -PythonPath "C:\path\python.exe"
```

## Troubleshooting

### Build Errors

If you encounter build errors:

1. For Windows one-click setup, review `.runtime/install.log`; CMake is supplied automatically during the build.
2. Ensure you have a C++17 compatible compiler and the platform SDK installed.
3. Try building with verbose output: `pip install . -v`

### Import Errors

If `import pymahjong` fails after installation:

1. Check if the package is installed: `pip show pymahjong`
2. Try reinstalling: `pip install --force-reinstall pymahjong`
3. Check Python version: `python --version` (requires 3.10+)
