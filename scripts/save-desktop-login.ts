import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadDesktopAccount } from "../src/account.ts";

const account = await loadDesktopAccount();
const authPath = join(homedir(), ".pi", "agent", "auth.json");
const auth = JSON.parse(readFileSync(authPath, "utf8"));
auth.zcode = {
  type: "oauth",
  refresh: account.accessToken || account.jwt,
  access: account.jwt,
  expires: Date.now() + 12 * 60 * 60 * 1000,
  mode: "zcode-plan",
  accountName: account.name,
  userId: account.userId,
  providerFamily: account.provider,
};
writeFileSync(authPath, JSON.stringify(auth, null, 2) + "\n");
console.log("saved", account.name, account.models.map((model) => model.id).join(","));
