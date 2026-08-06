# Bringing an existing template estate under management

**Who this is for.** Your organisation already has template repos — projects a
platform team maintains and other teams **copy by hand** to start new
services. It works, but nothing links the copies back to the template: fixes
don't propagate, nobody knows how far each project has drifted, and "reuse"
is a slogan rather than a number.

This guide walks the whole journey — the **brownfield arc** — using a
fictional platform team at *Acme* with a template repo (`acme-portal`) and a
hand-copied instance (`zed-portal`):

```
hex hexify     the template repo becomes a hex template   (in place, proven)
hex adopt      each hand-copied instance links to it       (writes .hex/ only)
hex upgrade    template improvements propagate to all      (3-way merge)
```

Every step is designed to be defensible in a change-review meeting, so the
safety contract comes first.

## The safety contract

| Command | What it writes | Undo |
|---------|----------------|------|
| `hex hexify` | Rewrites the template repo in place — but **only after** a round-trip proof, and only on a **clean git tree**. | `git checkout .` + `git clean -fd -- .hex .hexignore` |
| `hex hexify --dry-run` | **Nothing.** Full pipeline, proof included. | — |
| `hex adopt` | `.hex/` **only**. No project file is created, modified, or deleted. | `rm -rf .hex` |
| `hex adopt --dry-run` | **Nothing.** Prints the fit report. | — |
| `hex upgrade` | The 3-way merge you asked for — your edits preserved, conflicts surfaced. | git, as ever |

The **round-trip proof** is hexify's core guarantee: the hexified template is
built in a throwaway shadow directory and rendered back with the original
values as answers — nothing touches your repo unless every file returns
**byte-identical**. Determinism, not trust.

## Prerequisites

- Node 20+, git, and `npm i -g @hexology/hex` (1.2.0 or later).
- The template repo checked out, committed clean.
- Ideally: one known instance of it, for `--against` (below).

## Step 1 — Hexify the template repo

From the template repo root:

```sh
hex hexify --dry-run     # rehearse: full dialogue + proof, zero writes
hex hexify               # the real thing
```

The guided dialogue proposes parameterisation candidates seeded from
`package.json` — name, description, author, license — each with occurrence
counts:

```
Parameterise "acme-portal" as {{ project_name }}? (12 occurrences in 5 files, 1 filename)
```

Every value you confirm becomes a manifest prompt whose **default is the
current concrete value** (so a render with all defaults reproduces the repo
exactly — that's what the proof checks), and every occurrence becomes a
`{{ placeholder }}` — in file contents *and* filenames
(`src/acme-portal.config.ts` → `src/{{ project_name }}.config.ts`).

Hexify also quietly handles the traps you'd hit doing this by hand: it
neutralises pre-existing template-engine hazards (GitHub Actions'
`${{ secrets.X }}` and friends) so they render back literally, and writes a
`.gitignore`-seeded `.hexignore` so on-disk `node_modules/` never enters the
template.

### Use a real instance as evidence: `--against`

If a hand-copied instance exists — and in this scenario it always does —
point hexify at it:

```sh
hex hexify --against ../zed-portal
```

The template↔instance diff is **mined for parameter candidates**: everywhere
the template says `acme-portal-svc` and the instance consistently says
`zed-portal-svc` is a parameter site, proposed with its evidence:

```
Parameterise "acme-portal-svc"? (↔ "zed-portal-svc" in the instance, 7 differing spots; 9 occurrences here)
```

This finds the values `package.json` seeding never can — service names in
deployment manifests, ports, org slugs. Two tips:

- **Use the instance at an early revision** (`git worktree add ../zed-early
  <first-commit> ` in the instance repo, then `--against ../zed-early`).
  Months of development drift just produces junk proposals to decline.
- Mining only ever *proposes*. Decline anything dubious — the round-trip
  proof is unaffected either way.

### Deeper parameterisation with an AI agent

Seeding and mining find single values. Real template repos also carry the
kind a diff can't surface — multi-word company names in licence headers,
casing variants, ports and org slugs that need judgment. For those, hand the
problem to an AI agent — **without putting any AI in the pipeline**:

```sh
hex hexify --against ../zed-portal --emit-prompt   # writes hexify-prompt.md
```

`hexify-prompt.md` is a self-contained briefing: the rules, everything Hex
already found, and instructions for the agent to check its own work. Give it
to whatever assistant your organisation has approved (or none — it reads
fine as a checklist for a human). The agent answers with a small
`hexify.plan.yaml` and can iterate against Hex headlessly:

```sh
hex hexify --plan hexify.plan.yaml --dry-run --json   # agent's verify loop — writes nothing
```

When the plan looks right, apply it interactively — every proposed parameter
is still confirmed by you, one by one, and the round-trip proof is unchanged:

```sh
hex hexify --plan hexify.plan.yaml
```

A wrong plan cannot corrupt anything: a value that appears nowhere counts 0
occurrences and is flagged, and nothing is written unless the render proof
passes. Hex never makes a network call and never invokes an AI itself — the
prompt and the plan are files you carry, which keeps the tool deterministic
and air-gap friendly while letting you use exactly as much AI as your
environment allows.

### Finish the step

Review with `git diff` (the changes are exactly what the report listed),
commit, and push a branch for review — the PR is self-explaining, and the
report's proof line ("N files render back byte-identical") is the reviewer's
assurance that nothing was lost.

## Step 2 — Validate against known instances (write nothing yet)

Before touching any team's repo, grade your hexification. From an instance:

```sh
cd ../zed-portal
hex adopt ../acme-portal --dry-run
```

The **fit report** classifies every file:

| Group | Meaning |
|-------|---------|
| clean | Byte-identical to what the template renders for this instance's values. |
| edited | Rendered by the template, but this project's bytes differ. |
| missing | The template renders it; this project deleted it. |
| untracked | This project's own files; the template doesn't know them. |

`fit % = clean / recorded`. Read it as a **hexification quality gauge**: a
low fit with a long edited-list usually means a parameterisation is missing
or wrong — the edited-list tells you exactly where. Fix the template,
re-run the dry-run (it wrote nothing, so there's nothing to undo), repeat
until the fit is honest.

> **Reading "edited" honestly.** If the template repo kept improving after
> the instance was copied, those improvements also show as "edited" — plain
> fit can't distinguish *the team changed this* from *the template moved on
> after the copy*. The instance's own git history can. Add `--provenance`:
>
> ```sh
> hex adopt ../acme-portal --dry-run --provenance
> ```
>
> The edited group splits into **edited by you** (real team work, preserved
> by upgrade), **stale** (the template improved; the first upgrade refreshes
> these for free), and **collided** (both changed — the future merge
> conflicts, known before any upgrade runs). The default baseline is the
> instance's root commit; pass `--provenance <tag-or-sha>` when you know the
> true copy point. "23 edited" becomes "6 team edits, 14 stale, 3 collisions
> to review" — a much better number to bring to a meeting, and a de-risked
> first upgrade.

## Step 3 — Adopt the instances

When the fit is credible, adopt for real:

```sh
hex adopt ../acme-portal          # interactive prompts, or:
hex adopt ../acme-portal --answers answers.yaml
```

The interactive prompts arrive **prefilled from the project's own
`package.json`** — a hand-copied instance carries its answers in-band, so
adopting a well-matched project is usually just Enter, Enter, Enter.

Adoption writes `.hex/` only — a lockfile recording the template, version,
and answers, plus the pristine baseline that future upgrades merge against.
Commit it; the diff is one new directory, which makes each adoption a small,
boring, reviewable PR. The instance is now indistinguishable from a project
Hex scaffolded on day one: `hex doctor` inspects it, `hex upgrade` upgrades
it.

Got the answers wrong, or improved the template's parameterisation since?
Run adopt again — it asks:

```
Already adopted (acme-portal@0.1.0) — re-adopt and replace the existing adoption? (y/N)
```

Declining changes nothing. Confirming (or `--readopt` in scripted runs)
replaces the adoption wholesale — note the merge base resets.

## Step 4 — Propagate an improvement

The payoff. The platform team improves the template — bumps its manifest
`version:`, commits. Each adopted instance runs:

```sh
hex upgrade ../acme-portal
```

Three-way merge against the pristine baseline: the template's change lands,
the team's edits survive, genuine collisions surface as conflicts to resolve
once. One fix, propagated across the estate, with every team's local
changes intact — this is the moment reuse stops being a slogan and becomes
a diff.

## Measuring reuse across the estate

Every report is machine-readable, so the estate-wide picture is a loop:

```sh
for repo in */; do
  fit=$(cd "$repo" && hex adopt ../acme-portal --dry-run --json \
    --answers answers.yaml | jq .fitPercent)
  echo "$repo  fit ${fit}%"
done
```

Fit-% per repo is a reuse metric a leadership dashboard can track; the
edited-lists are each team's reconciliation worklist.

## Limits worth knowing (1.2)

- **One template per project.** A project assembled by hand from several
  templates can adopt against one of them; multi-template adoption is a
  planned follow-up.
- **Component templates only** — recipes are not yet adoptable.
- Generated prompts are plain strings in V1 (no enum choices or validation
  patterns) — edit the generated `.hex/manifest.yaml` afterwards if you
  want richer prompts; it's a normal manifest, yours to refine.
- Hexify proposes values of 3+ characters; shorter values over-match and
  must be handled by hand if you truly need them.

## See also

- [`hex hexify`](../reference/cli.md#hex-hexify), [`hex adopt`](../reference/cli.md#hex-adopt) — full flag/exit-code reference
- [Authoring a template](./authoring-a-template.md) — refine the generated manifest by hand
- [Set up a catalogue for your org](./catalogue-for-your-org.md) — distribute the hexified templates to every team
- [Upgrading a generated app](../upgrade.md) — the merge mechanics in depth
