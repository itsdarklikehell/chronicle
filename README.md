![Chronicle — your personal, private Dungeon Master](docs/assets/banner.png)

# Chronicle

**Your personal, private Dungeon Master — right on your own computer.**

Chronicle is a beautiful, mobile-first solo Dungeons & Dragons app. A patient AI
storyteller runs the game, remembers every detail of your world, and keeps
perfect continuity from one session to the next. You play from your phone or
tablet; everything stays private on your home Wi-Fi.

It feels like opening a leather-bound journal with warm parchment pages and
candlelight — a Dungeon Master who is always ready, never gets tired, and never
forgets what happened last time.

<p align="center">
  <img src="docs/assets/screenshot-play.png" alt="The story screen on a phone" width="30%">
  <img src="docs/assets/screenshot-gallery.png" alt="Illustrations of your world" width="30%">
  <img src="docs/assets/screenshot-character-sheet.png" alt="Your character sheet" width="30%">
</p>

## Get started

Chronicle works on **Windows, Mac, and Linux**. Setup takes about 20–30 minutes
the first time, and you only do it once. Pick your computer and follow the
simple, picture-guided steps:

- 🪟 **[I use Windows →](docs/user-guide/install/windows.md)**
- 🍎 **[I use a Mac →](docs/user-guide/install/mac.md)**
- 🐧 **[I use Linux →](docs/user-guide/install/linux.md)**

New here and not sure where to begin? Start with the **[User Guide](docs/user-guide/index.md)** —
it walks you through everything, one calm step at a time.

## What you'll need

- A Windows, Mac, or Linux computer (laptop or desktop)
- A phone or tablet on the **same home Wi-Fi**
- A **Claude account** (a Claude Pro or Max subscription powers the storyteller —
  the guide shows you how to sign in)
- About 20–30 minutes the first time

## Configuration

Chronicle reads its settings from two JSON files at the repo root — `config.json` for
non-secret settings and `secrets.json` for passwords (both git-ignored). You don't have
to create them to start: a fresh checkout boots from the committed defaults. To change
anything, copy the templates and edit:

```bash
cp config.example.json config.json
cp secrets.example.json secrets.json
```

See the **[Configuration guide](docs/configuration.md)** for every setting, the
settings-vs-secrets split, and how to point image generation at a remote GPU host.

## Learn more

- 📖 **[User Guide](docs/user-guide/index.md)** — start here
- 🖼️ **[Adding pictures](docs/user-guide/adding-pictures.md)** — optional illustrations of your world
- 🎨 **[Customizing your story](docs/user-guide/customizing-your-story.md)** — art styles, world flavor, tone
- ⚙️ **[Configuration](docs/configuration.md)** — settings, secrets, and remote GPU hosts
- 🆘 **[Help & troubleshooting](docs/user-guide/help-and-troubleshooting.md)** — calm fixes for common hiccups

### For developers

- 📐 **[Developer & Architecture Guide](docs/developer-guide.md)** — how Chronicle works under the hood
- 🏗️ **[ADRs](docs/adr/)** — architecturally significant decisions, numbered sequentially
- 🧪 **Run tests:** `npm run test:unit` (291 tests) · `npm run typecheck` (TypeScript strict)
- 🔧 **Start dev server:** `npm run setup && npm start` (serves API + built UI on port 4317)
- 🛑 **Config-gated CI:** fleet-wide reusable workflows live in `itsdarklikehell/ci-templates`

## License

Chronicle is **[MIT licensed](LICENSE)** — free and open source. Take it, fork
it, change it, sell it; you only have to keep the copyright notice with it.

The one exception is the D&D rules text in `reference/srd/`, which is *System
Reference Document 5.2* © Wizards of the Coast LLC, used under
[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). It keeps its own
license and just asks that the attribution stays intact. See
**[NOTICE](NOTICE)** for the full picture. Chronicle is an independent project
and is not affiliated with or endorsed by Wizards of the Coast.

---

Your stories stay safe and private — nothing ever leaves your home network.

**Ready to begin?** Pick your computer above and let's get your personal Dungeon
Master set up. You've got this. 🕯️

<sub>Building on Chronicle or curious how it works? See the **[Developer & Architecture Guide](docs/developer-guide.md)**.</sub>


---

## 🎥 Gource Visualization

De ontwikkelhistorie van dit project wordt automatisch gegenereerd door de [Gource workflow](.github/workflows/gource.yml) bij elke push — rendered via [nbprojekt/gource-action@v1.3.0](https://github.com/marketplace/actions/gource-action) in 1080p. Het video-artifact is 30 dagen beschikbaar via de workflow-run (Actions → gource-visualization).

<video src="https://raw.githubusercontent.com/itsdarklikehell/chronicle/master/gource.mp4" controls width="100%"></video>
