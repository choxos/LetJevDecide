/**
 * Let Jev Decide, in the browser. Two deciders:
 *   Jev    POST {question, details} to the relay, which asks TypeSafe's Jev with the site's key
 *   coin   a fair flip from crypto.getRandomValues; heads means yes (make the change), as in
 *          Levitt's (2016) study, with one flip or best two out of three
 * The history and the chosen theme stay in localStorage.
 */

// The GitHub Pages copy sends questions to the relay; a copy served beside the relay uses its own.
const RELAY_HOST = "letjevdecide.xera.ac";
const SAME_ORIGIN = ["localhost", "127.0.0.1", RELAY_HOST].includes(location.hostname);
const RELAY = SAME_ORIGIN ? "" : `https://${RELAY_HOST}`;

const LOG_KEY = "ljd-log";
const THEME_KEY = "ljd-theme";
const MAX_LOG = 50;

// Words that mean nobody should flip a coin over this. Jev checks too, more carefully; this list
// covers the coin, which never sends the question anywhere.
const CRISIS =
  /\b(suicid\w*|kill(ing)? (myself|me|him|her|them|someone|somebody|my \w+)|end (my life|it all)|take my (own )?life|self[- ]?harm\w*|hurt(ing)? (myself|me|him|her|them|someone|somebody)|cut(ting)? myself|overdos\w*|want to die|don'?t want to (live|be alive))\b/i;

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const $ = (sel) => document.querySelector(sel);

/** A small element builder: h("p", {class: "x"}, "text", child). Text is always text, never HTML. */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

// ------------------------------------------------------------------------------ Jev

async function askJev(question, details, signal) {
  let res;
  try {
    res = await fetch(`${RELAY}/v1/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, details }),
      signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new Error("Jev could not be reached. Check your connection, or flip the coin.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Jev could not decide (error ${res.status}).`);
  return data;
}

async function checkStatus() {
  const dot = $("#dot");
  const text = $("#status-text");
  if (!dot) return;
  try {
    const r = await fetch(`${RELAY}/v1/health`, { signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    const on = r.ok && data.jev;
    dot.className = `dot ${on ? "on" : "off"}`;
    text.textContent = on ? `Jev is online (${data.model})` : "Jev is resting. The coin still works.";
  } catch {
    dot.className = "dot off";
    text.textContent = "Jev is offline. The coin still works.";
  }
}

// ------------------------------------------------------------------------------ the coin

function flip() {
  const b = new Uint8Array(1);
  crypto.getRandomValues(b);
  return b[0] & 1 ? "heads" : "tails"; // 256 values split evenly: exactly 50/50
}

/** One flip, or flips until one side has two. */
function tossCoins(three) {
  if (!three) return [flip()];
  const out = [];
  while (out.filter((f) => f === "heads").length < 2 && out.filter((f) => f === "tails").length < 2) out.push(flip());
  return out;
}

const coinEl = () => h("div", { class: "coin" }, h("div", { class: "face heads" }, "Yes"), h("div", { class: "face tails" }, "No"));

/** Spins a coin and lands it on `side`. Resolves when it has landed. */
function spin(coin, side) {
  const end = 360 * 5 + (side === "tails" ? 180 : 0);
  if (reduceMotion.matches || !coin.animate) {
    coin.style.transform = `rotateY(${end}deg)`;
    return Promise.resolve();
  }
  const anim = coin.animate(
    [
      { transform: "translateY(0) rotateY(0deg)" },
      { transform: `translateY(-56px) rotateY(${end / 2}deg)`, offset: 0.45 },
      { transform: `translateY(0) rotateY(${end}deg)` },
    ],
    { duration: 1200, easing: "cubic-bezier(.25,.6,.3,1)", fill: "forwards" },
  );
  return anim.finished.catch(() => {});
}

const wait = (ms) => new Promise((r) => setTimeout(r, reduceMotion.matches ? 0 : ms));

/** Draws the coins into `card`, flips them in turn and resolves to the overall side. */
async function runCoins(card, flips) {
  const three = flips.length > 1;
  const row = h("div", { class: `coins${three ? " three" : ""}` });
  const slots = [];
  for (let k = 0; k < (three ? 3 : 1); k++) {
    const coin = coinEl();
    const caption = h("div", { class: "coin-caption" });
    const slot = h("div", { class: "coin-slot" }, coin, caption);
    row.append(slot);
    slots.push({ slot, coin, caption });
  }
  card.append(row);
  for (let k = 0; k < flips.length; k++) {
    await spin(slots[k].coin, flips[k]);
    slots[k].caption.textContent = flips[k] === "heads" ? "Heads" : "Tails";
    if (k < flips.length - 1) await wait(200);
  }
  if (three && flips.length === 2) {
    // Two of the same settle it; the third coin was never needed.
    slots[2].slot.classList.add("dim");
    slots[2].caption.textContent = "Not needed";
  }
  const heads = flips.filter((f) => f === "heads").length;
  return heads * 2 > flips.length ? "heads" : "tails";
}

// ------------------------------------------------------------------------------ results

const pct = (p) => `${Math.round(p * 100)}%`;
const SIZE_NOTE = {
  major:
    "A decision this big is like the “important” questions in Levitt's coin toss study, such as quitting a job or ending a relationship. There, people the coin nudged into making a change were happier six months later, on average.",
  notable: "In Levitt's coin toss study, smaller changes such as a diet or a splurge made little difference to happiness either way.",
};

const word = (yes) => h("p", { class: `word ${yes ? "yes" : "no"}` }, yes ? "Yes" : "No");

function jevCard(out) {
  const yes = out.verdict === "yes";
  const meter = h("div", { class: `meter${yes ? " yes" : ""}`, role: "img", "aria-label": `Probability of yes: ${pct(out.yes)}` }, h("span"));
  const meta = h("p", { class: "meta" }, h("span", {}, `${pct(out.yes)} yes`));
  if (out.importance) meta.append(h("span", { class: "chip" }, `${out.importance.label} decision`));
  const card = h("article", { class: "card" }, h("p", { class: "who" }, "Jev says"), word(yes), h("p", { class: "says" }, yes ? "Do it." : "Don't do it."), meter, meta);
  requestAnimationFrame(() => requestAnimationFrame(() => (meter.firstChild.style.width = pct(out.yes))));
  if (out.torn) card.append(h("p", { class: "note" }, "Jev is on the fence: this one is close to 50/50, so a coin would be just as wise."));
  const note = out.importance && SIZE_NOTE[out.importance.key];
  if (note) card.append(h("p", { class: "note" }, note, " ", h("a", { href: "about.html#study" }, "About the study")));
  return card;
}

const coinCard = (three) => h("article", { class: "card" }, h("p", { class: "who" }, three ? "The coin says (best of three)" : "The coin says"));

function coinVerdict(card, side, flips) {
  const yes = side === "heads";
  const heads = flips.filter((f) => f === "heads").length;
  const how = flips.length > 1 ? `${yes ? "Heads" : "Tails"} wins ${Math.max(heads, flips.length - heads)} to ${Math.min(heads, flips.length - heads)}.` : yes ? "Heads." : "Tails.";
  card.append(word(yes), h("p", { class: "says" }, `${how} ${yes ? "Make the change." : "Keep things as they are."}`));
}

const message = (lines, actions = [], role = null) =>
  h("div", { class: "message", role }, lines.map((l) => h("p", {}, l)), actions.length ? h("div", { class: "actions" }, actions) : null);

function crisisCard() {
  return h(
    "div",
    { class: "message help", role: "alert" },
    h("p", { class: "big" }, "Nobody should flip a coin on this one. You deserve real help, right now."),
    h(
      "p",
      {},
      "If you are thinking about suicide or about hurting yourself or someone else, call or text ",
      h("a", { href: "tel:988" }, "988"),
      " in the US (the Suicide and Crisis Lifeline) or chat at ",
      h("a", { href: "https://988lifeline.org" }, "988lifeline.org"),
      ". In an emergency, call 911.",
    ),
    h("p", {}, "Outside the US, find a line near you at ", h("a", { href: "https://findahelpline.com" }, "findahelpline.com"), "."),
  );
}

// ------------------------------------------------------------------------------ history

function readLog() {
  const log = store.get(LOG_KEY, []);
  return Array.isArray(log) ? log : [];
}

function addLog(entry) {
  store.set(LOG_KEY, [entry, ...readLog()].slice(0, MAX_LOG));
  renderLog();
}

const answerSpan = (a) => (a === "yes" ? h("span", { class: "yes-text" }, "Yes") : h("span", { class: "no-text" }, "No"));

function renderLog() {
  const body = $("#log-body");
  if (!body) return;
  const log = readLog();
  body.replaceChildren();
  $("#clear-log").hidden = !log.length;
  if (!log.length) {
    body.append(h("p", { class: "empty" }, "No decisions yet."));
    return;
  }
  const when = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const rows = log.map((e) =>
    h(
      "tr",
      {},
      h("td", {}, when.format(new Date(e.at))),
      h("td", { class: "q" }, e.q),
      h("td", {}, e.by),
      h("td", { class: "a" }, e.jev ? answerSpan(e.jev) : null, e.jev && e.coin ? " · " : null, e.coin ? answerSpan(e.coin) : null),
    ),
  );
  body.append(
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        {},
        h("caption", { class: "sr-only" }, "Your past decisions, newest first"),
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "When"), h("th", { scope: "col" }, "Question"), h("th", { scope: "col" }, "Decider"), h("th", { scope: "col" }, "Answer"))),
        h("tbody", {}, rows),
      ),
    ),
  );
}

function setupHistory() {
  const dialog = $("#history");
  if (!dialog) return;
  $("#open-history").addEventListener("click", () => {
    renderLog();
    dialog.showModal();
  });
  $("#close-history").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close(); // a click on the backdrop
  });
  const clear = $("#clear-log");
  clear.addEventListener("click", () => {
    if (clear.dataset.armed) {
      store.set(LOG_KEY, []);
      delete clear.dataset.armed;
      clear.textContent = "Clear history";
      renderLog();
      return;
    }
    clear.dataset.armed = "1";
    clear.textContent = "Press again to clear";
    setTimeout(() => {
      if (clear.dataset.armed) {
        delete clear.dataset.armed;
        clear.textContent = "Clear history";
      }
    }, 4000);
  });
}

// ------------------------------------------------------------------------------ theme

const MOON = "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z";
const SUN = "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z";

function effectiveTheme() {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function setupTheme() {
  const btn = $("#theme-toggle");
  if (!btn) return;
  const paint = () => {
    const dark = effectiveTheme() === "dark";
    btn.setAttribute("aria-label", dark ? "Light theme" : "Dark theme");
    btn.querySelector("path").setAttribute("d", dark ? SUN : MOON);
  };
  paint();
  btn.addEventListener("click", () => {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
    paint();
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paint);
}

// ------------------------------------------------------------------------------ the form

function setupDecider() {
  const form = $("#ask");
  if (!form) return;
  const q = $("#question");
  const details = $("#details");
  const result = $("#result");
  const bar = $("#bar");
  const more = $("#more");
  const box = $("#details-box");
  const clear = $("#clear");
  const submits = [...form.querySelectorAll("button[type=submit]")];
  let controller = null;

  const syncClear = () => (clear.hidden = !q.value);
  q.addEventListener("input", syncClear);
  clear.addEventListener("click", () => {
    q.value = "";
    syncClear();
    q.focus();
  });

  more.addEventListener("click", () => {
    const open = box.hidden;
    box.hidden = !open;
    bar.classList.toggle("open", open);
    more.setAttribute("aria-expanded", String(open));
    if (open) details.focus();
  });

  // An example question is asked right away, the same way as pressing Enter: Jev decides, and
  // the coin too when "Also flip a coin" is ticked.
  for (const ex of form.querySelectorAll(".examples button")) {
    ex.addEventListener("click", () => {
      q.value = ex.textContent.trim();
      syncClear();
      decide("jev");
    });
  }

  const log = (question, by, fields) => addLog({ at: Date.now(), q: question, by, ...fields });
  const yesNo = (side) => (side === "heads" ? "yes" : "no");

  async function decide(chosen) {
    const question = q.value.trim().replace(/\s+/g, " ");
    const extra = box.hidden ? "" : details.value.trim();
    if (question.length < 3) {
      result.replaceChildren(message(["Type a yes or no question first, such as “Should I adopt a dog?”"]));
      q.focus();
      return;
    }
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    const three = $("#three").checked;
    const withCoin = chosen === "coin" || $("#compare").checked;
    const asked = h("p", { class: "asked" }, `“${question}”`);
    // Bring the answer into view once it is on the page, when it lands below the fold.
    const reveal = () =>
      requestAnimationFrame(() => {
        if (asked.isConnected && asked.getBoundingClientRect().top > window.innerHeight * 0.7) {
          asked.scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth", block: "start" });
        }
      });

    if (CRISIS.test(`${question} ${extra}`)) {
      result.replaceChildren(asked, crisisCard());
      reveal();
      return;
    }

    submits.forEach((b) => (b.disabled = true));
    try {
      if (chosen === "coin") {
        const card = coinCard(three);
        result.replaceChildren(asked, h("div", { class: "cards" }, card));
        reveal();
        const flips = tossCoins(three);
        const side = await runCoins(card, flips);
        if (signal.aborted) return; // a newer question replaced this one mid flip
        coinVerdict(card, side, flips);
        log(question, "Coin", { coin: yesNo(side) });
        return;
      }

      const thinking = h("div", { class: "card thinking" }, h("div", { class: "dots", "aria-hidden": "true" }, h("span"), h("span"), h("span")), "Jev is thinking it over");
      const cards = h("div", { class: `cards${withCoin ? " two" : ""}` }, thinking);
      result.replaceChildren(asked, cards);
      reveal();

      const jev = askJev(question, extra, signal);
      let side = null;
      if (withCoin) {
        const card = coinCard(three);
        cards.append(card);
        const flips = tossCoins(three);
        side = await runCoins(card, flips);
        if (signal.aborted) return;
        coinVerdict(card, side, flips);
      }

      let out;
      try {
        out = await jev;
      } catch (err) {
        if (signal.aborted) return;
        thinking.replaceWith(
          message([err.message], [h("button", { type: "button", class: "btn", onclick: () => decide("coin") }, "Flip a coin instead")], "alert"),
        );
        if (side) log(question, "Coin", { coin: yesNo(side) });
        return;
      }
      if (signal.aborted) return;

      if (out.verdict === "crisis") {
        result.replaceChildren(asked, crisisCard());
        return;
      }
      if (out.verdict === "not-yes-no") {
        thinking.replaceWith(
          message([
            "Jev only answers questions that can be settled with a yes or a no.",
            "Try asking about one thing you might do: “Should I order the pizza?” rather than “Pizza or tacos?”",
          ]),
        );
        if (side) log(question, "Coin", { coin: yesNo(side) });
        return;
      }

      thinking.replaceWith(jevCard(out));
      if (side) {
        const agree = yesNo(side) === out.verdict;
        result.append(
          h(
            "p",
            { class: "agree" },
            agree
              ? `Jev and the coin agree: ${out.verdict === "yes" ? "yes" : "no"}.`
              : "Jev and the coin disagree. Which answer were you hoping for? That hope may be your real answer.",
          ),
        );
      }
      result.append(h("p", { class: "fine" }, "For fun, not professional advice. You make the final call."));
      log(question, side ? "Jev and coin" : "Jev", side ? { jev: out.verdict, coin: yesNo(side) } : { jev: out.verdict });
    } finally {
      if (!signal.aborted) submits.forEach((b) => (b.disabled = false));
      if (controller?.signal === signal) controller = null;
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    decide(e.submitter?.value === "coin" ? "coin" : "jev");
  });
}

setupTheme();
setupHistory();
setupDecider();
checkStatus();
