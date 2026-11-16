import { isCurrencyCode, type SandboxMode } from "@relay/domain";
import { formatMoney, shortDate } from "../../lib/display.ts";

const css = `
*{margin:0;box-sizing:border-box}html,body{min-height:100%;color-scheme:light}
body{background:#ECECE6;color:#111;font-family:ui-monospace,"Cascadia Mono","SFMono-Regular",Menlo,Consolas,monospace;font-size:14px;line-height:21px}
.sb{min-height:100dvh;display:flex;flex-direction:column}.sb-stripe{height:12px;flex:none;background:repeating-linear-gradient(135deg,#111 0 14px,#F2C200 14px 28px)}
.sb-top{display:flex;align-items:center;gap:12px;padding:16px 40px;min-height:64px;border-bottom:2px solid #111;background:white}
.sb-mark{width:22px;height:22px;border:2px dashed #111;flex:none}.sb-name{font-size:16px;font-weight:bold;letter-spacing:.04em}
.sb-tag{margin-inline-start:auto;font-size:13px;font-weight:bold;letter-spacing:.04em;padding:5px 10px;background:#111;color:#F2C200}
.sb-banner{padding:9px 40px;border-bottom:2px solid #111;background:#FFFBE0;font-size:13px;line-height:19px;font-weight:bold;letter-spacing:.04em}
.sb-main{flex:1;display:grid;grid-template-columns:440px 580px;gap:32px;justify-content:center;align-content:center;align-items:start;padding:32px 20px}
.sb-form{display:contents}.sb-card{background:white;border:2px solid #111;padding:28px;display:flex;flex-direction:column;gap:18px;min-width:0}.sb-demo{border-style:dashed;background:#FFFBE0;gap:14px}
.sb-label{font-size:12px;line-height:16px;font-weight:bold;letter-spacing:.06em;color:#4A4A45}.sb-amount{font-size:40px;line-height:46px;font-weight:bold}.sb-note{font-size:13px;line-height:19px;color:#3D3D39}
h1,h2{font-size:16px;line-height:22px;font-weight:bold;letter-spacing:.04em}.sb-school{font-size:18px;line-height:26px;font-weight:bold}.sb-facts{display:grid;grid-template-columns:1fr 1fr;gap:16px;overflow-wrap:anywhere}
.sb-pay{min-height:52px;border:0;background:#111;color:white;font:inherit;font-size:16px;font-weight:bold;letter-spacing:.02em;cursor:pointer;padding:12px}.sb-pay:hover{background:#333}.sb-pay:disabled{background:#4A4A45;cursor:default}
:focus-visible{outline:3px solid #111;outline-offset:3px}.sb-pay:focus-visible{outline-color:#F2C200}
fieldset{border:0;min-width:0}.sb-options{display:flex;flex-direction:column;gap:4px;margin-top:8px}.sb-opt{display:flex;gap:12px;align-items:flex-start;padding:10px 12px;border:2px solid transparent;cursor:pointer}.sb-opt:hover{background:#FFF3B8}.sb-opt:has(input:checked){border-color:#111;background:white}.sb-radio{width:18px;height:18px;flex:none;margin-top:2px;accent-color:#111}.sb-opt-t{font-weight:bold;display:block}
.sb-foot{padding:14px 40px;border-top:2px solid #111;font-size:13px;line-height:19px;color:#3D3D39;background:white}a{color:#111;text-underline-offset:3px}.sb-status{padding:12px;border:2px solid #111;background:#FFFBE0}
@media(max-width:1100px){.sb-main{grid-template-columns:minmax(0,440px) minmax(0,580px)}}
@media(max-width:700px){.sb-main{grid-template-columns:1fr;padding:20px}.sb-top{padding:16px 20px;flex-wrap:wrap}.sb-tag{margin:0}.sb-banner,.sb-foot{padding:12px 20px}.sb-form{display:contents}.sb-card{padding:20px}.sb-opt{min-height:44px}.sb-facts{grid-template-columns:1fr}}
`;
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
export function sandboxPage(
  row: {
    id: string;
    paymentId: string;
    amount: bigint;
    currency: string;
    expiresAt: Date;
    status: string;
    mode: string;
  },
  demo: boolean,
  lateMs: number,
  nonce: string,
) {
  const amount = isCurrencyCode(row.currency)
    ? formatMoney({ minor: row.amount, currency: row.currency })
    : `${row.amount.toString()} minor units`;
  const choices: { mode: SandboxMode; title: string; body: string }[] = [
    {
      mode: "normal",
      title: "Deliver it normally",
      body: "The webhook arrives right after payment and Relay CRM completes the payment.",
    },
    {
      mode: "drop",
      title: "Drop it",
      body: "No webhook is sent. Relay CRM's reconciler asks this provider and completes the payment.",
    },
    {
      mode: "twice",
      title: "Send it twice",
      body: "The same webhook is delivered two times. The second one changes nothing.",
    },
    {
      mode: "late",
      title: "Send it late",
      body: `The webhook waits ${String(lateMs / 1000)} seconds. If the reconciler completes the payment first, the webhook changes nothing.`,
    },
    {
      mode: "differentAmount",
      title: "Report a different amount",
      body: `The provider reports one minor unit more than ${amount}. Relay CRM moves the payment to review and credits nothing.`,
    },
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sandbox Provider checkout</title><style nonce="${nonce}">${css}</style></head><body><div class="sb"><div class="sb-stripe"></div><header class="sb-top"><span class="sb-mark" aria-hidden="true"></span><h1 class="sb-name">SANDBOX PROVIDER</h1><span class="sb-tag">SANDBOX · NO REAL MONEY MOVES</span></header>${demo ? '<aside class="sb-banner" aria-label="Demo">DEMO · INVENTED DATA. IT RESETS EVERY NIGHT.</aside>' : ""}<main class="sb-main"><form method="post" class="sb-form"><section class="sb-card" aria-label="Checkout"><div><div class="sb-label">PAY TO</div><div class="sb-school">Tidewell Language School</div></div><div><div class="sb-label">AMOUNT</div><div class="sb-amount">${escape(amount)} <span class="sb-school">${escape(row.currency)}</span></div></div><dl class="sb-facts"><div><dt class="sb-label">CHECKOUT REFERENCE</dt><dd>SBX-${escape(row.id.slice(-8).toUpperCase())}</dd></div><div><dt class="sb-label">EXPIRES</dt><dd>${escape(shortDate(row.expiresAt, "UTC"))} UTC</dd></div></dl><p class="sb-note">This page stands in for a card provider. It does not ask for card details and no card is charged.</p>${row.status === "pending" ? `<button class="sb-pay" type="submit">Pay ${escape(amount)}</button>` : `<p role="status" tabindex="-1" autofocus class="sb-status">${row.status === "completed" ? "Paid in the sandbox" : `This checkout is ${escape(row.status)}`}. No real money moved.</p>`}<p class="sb-note">After you pay, <a id="return-to-payment" href="/payments/${escape(row.paymentId)}">go back to Relay CRM</a> to see what it recorded.</p></section>${demo ? `<section class="sb-card sb-demo" aria-label="Demo controls"><div><h2>DEMO CONTROLS</h2><p class="sb-note">Only the sandbox has these. A real provider's page does not.</p></div><fieldset ${row.status !== "pending" ? "disabled" : ""}><legend class="sb-label">AFTER YOU PAY, WHAT HAPPENS TO THE WEBHOOK?</legend><div class="sb-options">${choices.map((choice) => `<label class="sb-opt"><input class="sb-radio" type="radio" name="mode" value="${choice.mode}" ${row.mode === choice.mode ? "checked" : ""}><span><span class="sb-opt-t">${choice.title}</span><span class="sb-note">${escape(choice.body)}</span></span></label>`).join("")}</div></fieldset></section>` : ""}</form></main><footer class="sb-foot">Sandbox Provider is a stand-in built into Relay CRM for demos and tests. It is not a real payment company.</footer></div><script nonce="${nonce}">document.getElementById("return-to-payment").addEventListener("click", function(event) { event.preventDefault(); location.replace(this.href); });
document.querySelector("form").addEventListener("submit", async function(event) {
  event.preventDefault();
  const button = this.querySelector("button");
  button.disabled = true;
  try {
    const response = await fetch(location.href, { method: "POST", body: new URLSearchParams(new FormData(this)), referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error("Payment could not be recorded. Reload the page to check its state.");
    location.replace(location.href);
  } catch {
    const message = document.createElement("p");
    message.setAttribute("role", "alert");
    message.textContent = "Payment could not be recorded. Reload the page to check its state.";
    button.replaceWith(message);
  }
});</script></body></html>`;
}
