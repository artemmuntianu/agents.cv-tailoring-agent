# apps/worker/fonts - the licensed Microsoft fonts the worker image bakes in

Drop the **real** Calibri family here and `docker build` installs it into the image
(`Dockerfile` -> `/usr/share/fonts/truetype/ms-calibri/` + `fc-cache -f`), so
LibreOffice stops substituting and the rendered PDF carries the same outlines Word
shows.

```powershell
.\scripts\fetch-fonts.ps1        # copies the six files out of C:\Windows\Fonts
.\scripts\local-deploy.ps1       # rebuilds the image with them baked in
```

Six files are expected - four body, two Light:

| File | Role |
|---|---|
| `calibri.ttf`, `calibrib.ttf`, `calibrii.ttf`, `calibriz.ttf` | Calibri regular / bold / italic / bold-italic (CV body) |
| `calibril.ttf`, `calibrili.ttf` | Calibri **Light** regular / italic (the CV headings: `w:asciiTheme="majorHAnsi"`) |

Why the genuine files: Carlito is *metric*-compatible with Calibri, so body text wraps
and paginates identically, but it is a **different design** and has **no Light weight**.
The headings therefore came out in DejaVu Serif, which matches Word in neither respect.
Real Calibri removes the substitution.

**These files are Microsoft-licensed and are never committed.** `apps/worker/fonts/*.ttf`
is gitignored. The Docker build context is `apps/worker/`, so `fonts/` sits inside it and
`apps/worker/Dockerfile` COPYs it directly - nothing needs whitelisting. An image built
without them is fine - CI builds exactly that - it simply
renders Calibri Light in DejaVu Serif, which is the behaviour recorded as **D15** in
`CONSTITUTION.md`. Never commit these files and never publish an image that contains them.
