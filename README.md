# Let Jev Decide

Stuck on a yes or no decision? Type it in, then let **Jev** decide, or flip a fair **coin**.

**Use it at [choxos.github.io/LetJevDecide](https://choxos.github.io/LetJevDecide/)** or
[letjevdecide.xera.ac](https://letjevdecide.xera.ac). No sign up, no install.

* **Ask Jev.** Jev is [TypeSafe](https://typesafe.ai)'s System One model. It does not write text; it answers typed
  questions with probabilities. Your question gets a yes or a no, the probability of yes behind it, and how big a
  decision Jev thinks it is. Add details with the slider button in the question box and Jev weighs them too.
* **Flip a coin.** A fair flip made in the browser with `crypto.getRandomValues`. Heads means yes (make the change),
  tails means no (keep things as they are). Flip once or go for best two out of three.
* **Or both.** Tick *Also flip a coin* to ask Jev and flip at the same time, and see whether they agree.

## The study behind it

The idea comes from a real field experiment:

> Levitt, Steven D. 2016. "Heads or Tails: The Impact of a Coin Toss on Major Life Decisions and Subsequent Happiness."
> NBER Working Paper 22487. <https://www.nber.org/papers/w22487>. Published in *The Review of Economic Studies* 88 (1):
> 378-405 (2021). <https://doi.org/10.1093/restud/rdaa016>

In 2013, visitors to FreakonomicsExperiments.com who were stuck on a decision (quit my job, break up, go back to
school, get a tattoo) let a coin decide it: heads meant make the change, tails meant keep things as they are. About
56% chose best two out of three. Of 22,511 usable coin tosses:

* The coin changed what people did. People who got heads were about 25 percentage points more likely to make the
  change than people who got tails, and about 63% followed the coin at two months.
* Because the coin was random, it could show cause and effect. For important decisions, such as quitting a job or
  ending a relationship, making the change made people happier six months later. For less important ones, such as a
  diet, it made little difference.
* In Levitt's words, "people may be excessively cautious when facing life-changing choices." He also calls the
  results "merely suggestive": happiness was self reported and not everyone answered the follow up surveys.

This site borrows the study's coin (heads means yes; one flip or best of three) and adds Jev as a second decider. Only
the coin is random: Jev's answer depends on what you tell it. The [About page](https://choxos.github.io/LetJevDecide/about.html#study)
tells the study in more detail. It is for fun, not professional advice.

## How Jev decides

One request to `POST https://api.typesafe.ai/v1/systemone` asks four questions about the same state, so they run in
parallel ([`relay/decide.js`](relay/decide.js)):

| Question | Type | Used for |
| --- | --- | --- |
| `crisis` | Noul | At 0.5 or more: no verdict, and the page shows where to find help instead |
| `is_yes_no` | Noul | Below 0.3: the page asks for a yes or no question instead of deciding |
| `decide` | Noul | The probability of yes. Yes at 0.5 or more, no below; within 0.1 of 0.5, Jev is on the fence |
| `importance` | Score | Trivial, minor, notable or major, the study's important and less important questions |

The model is pinned (`jev-1.13.0`). A decision costs about 800 input tokens, about three thousandths of a cent. The coin
also has a small word list for questions that must not be decided by a coin, since it never sends the question
anywhere.

## How it is built

```
docs/                    the site, served by GitHub Pages: plain HTML, CSS and JavaScript, no build step
  index.html, app.js       the question box, both deciders, history (localStorage)
  about.html               how it works, the study, privacy
relay/
  server.js              the relay: POST /v1/decide, GET /v1/health, and the site for local use
  decide.js              what Jev is asked and how its answers become a verdict
test/                    node --test: request building, the verdict policy, the relay
```

The TypeSafe API does not accept requests from web pages, and the key must never reach a browser, so the GitHub Pages
copy sends questions to the relay at `letjevdecide.xera.ac`. The relay is not a general TypeSafe proxy: it accepts only
a question (up to 200 characters) and optional details (up to 1,000), builds the one request above and returns the
verdict. It only answers pages from the origins it lists, caps decisions per minute per visitor and input tokens per
day, and keeps no copy of the questions.

## Run it yourself

Needs Node 20 or newer and a TypeSafe key from [console.typesafe.ai](https://console.typesafe.ai/keys). There are no
dependencies to install.

```sh
cp .env.example .env     # paste your key into TYPESAFE_API_KEY
npm start                # http://localhost:8788
npm test
```

To host the relay, run `node relay/server.js` behind any HTTPS reverse proxy with the settings in
[`.env.example`](.env.example): `ALLOWED_ORIGINS` for the sites that call it, `PUBLIC_HOSTS` for its own host name,
`TRUST_PROXY=1`, and a `DAILY_TOKEN_BUDGET`. Then change `RELAY_HOST` at the top of [`docs/app.js`](docs/app.js).

## Privacy

With the coin, nothing leaves the browser. With Jev, the question and any details go to the relay and on to TypeSafe
for an answer; the relay does not store them. History is kept in the browser's localStorage. There are no cookies,
analytics or trackers.

## License

[MIT](LICENSE). Made by Ahmad Sofi-Mahmudi.
