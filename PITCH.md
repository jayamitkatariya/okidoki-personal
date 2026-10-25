# okidoki — pitch

**One line:** Amari built an AI agent for customs paperwork and became a $100M company. okidoki brings that agent to every company.

**Tagline to repeat (open, middle, close):** *Every company deserves an okidoki.*

---

## The 3-minute stage pitch

Each beat lists what you SAY and what's ON SCREEN. Pauses are marked ⏸; take them, because silence is what makes a number land.

### 1 · The story (0:00–0:35)

**SAY**
> Every machine my dad exports leaves a stack of paperwork behind it.
>
> My uncle's company exists to fill that stack in. Same regulations, same forms, same fields, every day. ⏸ That *is* the business.
>
> Here in the US, I met the founder of Amari, a $100 million company doing exactly what my uncle does, except AI agents fill in the forms.
>
> That's when it clicked. My uncle is never getting an Amari. ⏸ But every company has its own version of his office: billing, onboarding, compliance.
>
> Every company deserves an okidoki.

**ON SCREEN:** a single title slide, "okidoki", or just the notch with the app idle. Nothing else; the story carries this part.

### 2 · What it is (0:35–0:50)

**SAY**
> okidoki is an AI teammate that lives in your cursor.
> For a **team**, it's in your group chat. Ask, and it does the job on a real Mac, with your company's files.
> For **you**, shake your cursor, and it teaches you the task or just does it.
>
> Let me show you a Monday morning at Meridian, a customs brokerage.

**ON SCREEN:** switch to the control panel showing the Meridian work account.

### 3 · Demo: the team (0:50–1:50)

**SAY**
> This is Meridian's team chat. ⏸ Elena needs entry numbers for two shipments by end of day. Priya needs a customs form. Normally that's someone's whole morning. I'll just ask okidoki.

**ON SCREEN:** Spaces → **#Lakeshore Electronics**, where Elena's message is visible. Type:
`@okidoki file entries for MTS-4471 and MTS-4472`

**SAY** (when the approval card appears in the notch)
> Before it touches anything, it asks. Anyone in the space can approve. ⏸ Do it.

**ON SCREEN:** click **Do it** in the notch. The ghost cursor starts filling CBP Form 7501 in the Entry Workbench.

**SAY** (over the replay; this is the ~40 s you need to fill)
> Someone showed okidoki this form once. Now it replays it with each shipment's data. ⏸
> There's no AI picking every click. It finds each field by name, or by sight if the screen moved, and only asks Claude about a step that broke.
> That's 32 fields, about twenty seconds an entry. ⏸ A broker spends ten to fifteen minutes.

**ON SCREEN:** the run card in chat updates live, then posts both entry numbers.

**SAY**
> Two entry numbers, posted back in the chat for Elena. ⏸
> And Priya's form:

**ON SCREEN:** in **#Compliance**, type `@okidoki add the CBP 3461 to the compliance vault`. The file line appears in the chat.

**SAY**
> It found the official form and filed it in the company vault for the next job.

### 4 · Demo: you (1:50–2:25)

**SAY**
> Now I'm the new hire. I don't know any of this.

**ON SCREEN:** shake the cursor and type a teach request you've rehearsed (keep it short; 3–4 steps).

**SAY**
> I shake my cursor, and it teaches me on my own screen, one step at a time. ⏸ No shadowing, no forty-page doc.
>
> Or I just want it done:

**ON SCREEN:** shake, then ask for your fastest rehearsed task. Let it run a couple of steps, then press **Esc**.

**SAY**
> …and Escape gives me control back, instantly.

### 5 · Why you can trust it (2:25–2:40)

**SAY**
> **It's fast:** a typical task takes about 13 seconds. **It's careful:** anything risky asks first, and passwords are encrypted before they leave your Mac. **It's yours:** its memory stays on your machine.

### 6 · Close (2:40–3:00)

**SAY**
> My uncle doesn't need a $100 million company to build him an agent. ⏸ He needs a teammate that watches his team do the work once, then does it for them.
>
> Every company deserves an okidoki. Thank you.

---

## The 30-second version (for judges walking up to your table)

> My uncle's customs company fills out the same forms all day. Amari became a $100M startup by doing that with AI, but only for customs.
> okidoki does it for any company. Your team shows it a task once in a group chat, and it replays it on a real Mac. Watch: *(start the MTS-4471 replay)*. That's 32 fields in about 20 seconds.
> And for individuals, you shake your cursor and it teaches you the task or just does it.

Then stop talking and let the demo run.

---

## Track pitches: why each sponsor is essential, not just bolted on

Open each one with "Without ___, okidoki can't ___."

- **Anthropic.** *Without Claude, okidoki can't see or decide.* Claude reads the screen, the Mac's context and recalled memory, then makes a plan. A **second Claude call reviews that plan against the original request** before anything runs, so a plan that drifts from what you asked never executes. Haiku 5.5 drives with batched actions and cached prompts, which is how a task takes 13 seconds. Sonnet 5.5 writes the teaching steps, because explaining a busy screen to a person needs the bigger model.
- **Convex.** *Without Convex, okidoki is one person's tool, not a teammate.* Every Spaces message, job card, approval and vault file is a realtime `useQuery`. That's why the entry numbers appeared in the chat live. Sync between Macs is versioned with tombstones: if another Mac synced in between, the push is refused and retried, so nothing gets overwritten blindly. Convex Auth and per-Mac device tokens mean a Mac can only touch its own login's data. A cron cleans up jobs whose worker went silent.
- **Moss.** *Without Moss, okidoki starts every request from zero.* It indexes your notes, recent chats, tasks, skills and the team vault. Each request recalls only from your own account, and the index lives on your Mac, not in the cloud.
- **Cartesia.** *Without Cartesia, okidoki is a text box.* Sonic 3 gives it a voice, with 9 to choose from. It only speaks when you spoke first, stays quiet in quiet mode and on calls, and falls back to the Mac's own voice if Cartesia is unreachable.
- **Apify.** *Without Apify, okidoki can only work on what's already on your screen.* It has 18 built-in actors for pulling data from the web, and it shows you the cost before running a paid one.

---

## Judge Q&A

- **"How is this different from UiPath or RPA?"** RPA needs a developer to script each workflow, and it breaks when the UI moves. okidoki learns by watching you once, re-finds controls by name and then by sight, and only asks Claude for the one step that broke.
- **"How is this different from Claude computer use or Operator?"** Those reason through every click from scratch. okidoki replays what it already knows, and when it does need the model it sends a batch of actions per turn instead of one. It also lives in your team's chat, with approvals and a shared vault.
- **"Why not just use Amari?"** Amari proves the market, but it's built for customs. A dental clinic's billing desk isn't getting an Amari. With okidoki, any team teaches it its own process.
- **"What if it fills in a customs form wrong?"** Every field value is checked before anything is touched. A filing has to return a real entry number, or the run says it failed. And nothing runs without someone approving it.
- **"Does it run on my Mac while I'm working?"** It can run on a private Mac, which is a sandboxed macOS VM, or on a teammate's Mac that takes jobs for the space. Hosted VMs are next.
- **"Business model?"** Free for individuals, and per-seat pricing for teams (Spaces, the Vault, workers). *Decide this before stage.*

---

## Before you go on stage

- [ ] `bun scripts/demo-meridian/seed.ts --fresh`, then launch with `scripts/launch-app.sh`
- [ ] Rehearse both team lines with `scripts/demo-meridian/rehearse.sh "<line>"`, and update "about twenty seconds" if your timing differs
- [ ] Pick and rehearse the teach task and the "do it" task, keeping each under 20 s
- [ ] Record a backup video of the whole demo (the live run needs the network for Claude, Convex and Cartesia)
- [ ] If you mention Sonnet taking over stuck runs, first run `defaults write com.jaykatariya.okidoki drivingEscalate -bool true` (it's off by default)
- [ ] Time the script out loud and cut the vault beat first if you run over 3:00

## Numbers you can defend (from your own telemetry)

| Claim | Source |
|---|---|
| Typical task takes about 13 s | Median of 164 logged computer-use runs (12.8 s; 132 done) |
| 32-field entry in about 20 s | Replays of "file ACE entry" in `state.json` (~21 s) |
| A broker takes 10–15 min per entry | Industry estimate. Ask Amari's founder or your uncle for a real figure if you can; a quote from them beats a guess |
| "10x faster" | **Don't say it** unless you name what it's compared against |
