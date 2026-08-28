# CCPOA Bargaining Unit 6 MOU — Search & Grievance Deadlines

A searchable, AI-powered version of the BU 6 MOU, plus a grievance deadline
calculator built on Article VI. This is the deployable version of the
Claude.ai prototype — same behavior, but hosted on the open web so multiple
reps can use it without going through Claude.ai.

## What's different from the Claude.ai artifact version

The Claude.ai artifact could call Anthropic's API for free, with no key,
because Claude.ai artifacts get special built-in access. A site hosted
anywhere else needs its own API key. This project keeps that key safe by
routing all AI calls through a small serverless function (`api/ask.js`) that
runs on the server, never in the browser — so the key is never exposed to
anyone visiting the site.

## Deploy it (free tier, ~10 minutes)

### 1. Get an Anthropic API key
Go to [console.anthropic.com](https://console.anthropic.com), sign in (or
create an account), and generate an API key under **API Keys**. Anthropic
gives new accounts some free credit; after that, cost is pay-as-you-go —
at the traffic level this is likely to see, expect a few dollars a month at
most (see the cost breakdown from our earlier conversation).

### 2. Put this project on GitHub
- Create a free [GitHub](https://github.com) account if you don't have one.
- Create a new repository (e.g. `bu6-mou-search`).
- Upload all the files in this project to that repo. You can do this by
  dragging the whole folder into GitHub's web upload page — no command line
  needed.

### 3. Deploy on Vercel
- Create a free [Vercel](https://vercel.com) account (you can sign up with
  your GitHub account directly).
- Click **Add New → Project**, and import the GitHub repo you just created.
- Vercel will auto-detect this as a Vite project — leave the default
  settings.
- Before clicking Deploy, open **Environment Variables** and add:
  - Key: `ANTHROPIC_API_KEY`
  - Value: (paste the API key from step 1)
- Click **Deploy**.

That's it — Vercel gives you a live URL (like `bu6-mou-search.vercel.app`)
that anyone can visit. Every time you push changes to the GitHub repo,
Vercel automatically redeploys.

## Updating the MOU text later

When a new sideletter, amendment, or full revision comes out:
1. Save the fully-loaded CalHR MOU page as an `.mht` file (as before).
2. Send it back to Claude to re-parse into `src/data/mouSections.js`.
3. Replace that file in your GitHub repo (or ask Claude to just hand you
   the updated file to re-upload).
4. Vercel redeploys automatically.

## Local development (optional)

If you want to run this on your own computer before deploying:

```bash
npm install
npm run dev
```

Note: the AI search won't work locally unless you also run a local version
of the `/api/ask` function with your API key available as an environment
variable — Vercel handles this automatically once deployed, but plain
`vite dev` alone won't run the serverless function locally. Vercel's own
CLI (`vercel dev`) will, if you want to test that part locally too.

## Project structure

```
├── index.html              Entry HTML
├── src/
│   ├── main.jsx             React entry point
│   ├── App.jsx               Main app (search UI, grievance calculator)
│   └── data/
│       ├── mouSections.js    All 245 parsed MOU sections
│       └── payScales.js      CalHR/CDCR pay scale reference data
├── api/
│   └── ask.js                 Serverless function — calls Anthropic securely
├── vercel.json                Routing config
├── package.json
└── vite.config.js
```
