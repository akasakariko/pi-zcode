import { loadDesktopAccount, formatQuota } from "../src/account.ts";

const account = await loadDesktopAccount();
console.log(JSON.stringify({
  provider: account.provider,
  name: account.name,
  plans: account.plans.map((plan) => ({ name: plan.name, status: plan.status, models: plan.models })),
  models: account.models.map((model) => formatQuota(model)),
  hasJwt: account.jwt.startsWith("eyJ"),
  hasApiKey: Boolean(account.apiKey),
}, null, 2));
