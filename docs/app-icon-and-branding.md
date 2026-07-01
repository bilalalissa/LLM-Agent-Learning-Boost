# App Icon and Branding

The product identity is `LLM Agent Learning Boost`.

## Source Asset

Editable source:

- `assets/icon/llm-agent-learning-boost-icon.svg`

This SVG is project-owned artwork and does not use third-party copyrighted imagery.

## Generated macOS Assets

Generated app resources:

- `native/macos/LLMWikiAgent/Resources/AppIcon.png`
- `native/macos/LLMWikiAgent/Resources/AppIcon.icns`

The macOS build scripts use these files when creating:

- `build/macos/LLM Agent Learning Boost.app`

## Browser Companion Icons

The browser companion extension includes PNG icons:

- `extension/arc-clipper/icons/icon-16.png`
- `extension/arc-clipper/icons/icon-32.png`
- `extension/arc-clipper/icons/icon-48.png`
- `extension/arc-clipper/icons/icon-128.png`

## Regeneration

Use the existing icon scripts:

```bash
chmod +x scripts/generate_app_icon.sh
./scripts/generate_app_icon.sh
```

The generated assets should remain consistent with the source SVG and should not introduce incompatible third-party artwork.
