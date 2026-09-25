import { neededAccounts, validateSnapshot, SCHEMA_VERSION } from "./contract";

const valid = {
  schemaVersion: SCHEMA_VERSION,
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      enabled: true,
      defaultModel: null,
      accounts: [
        {
          id: "__main__",
          label: "main",
          plan: null,
          status: "ok",
          updatedAt: "2027-01-15T08:00:00.000Z",
          windows: [{ id: "weekly", label: "주간", remainingPercent: 0, resetAt: null, usageScope: null }],
        },
      ],
    },
  ],
};

validateSnapshot(valid);

try {
  validateSnapshot({ schemaVersion: 2, providers: [] });
  throw new Error("schemaVersion 2 must fail");
} catch (error) {
  if (error instanceof Error && error.message === "schemaVersion 2 must fail") throw error;
}

if (neededAccounts(100, 168, 24) !== 7) throw new Error("weekly 24h 100pp");
if (neededAccounts(100, 720, 24) !== 30) throw new Error("monthly 24h 100pp");

const zeroWindow = valid.providers[0]?.accounts[0]?.windows[0];
if (zeroWindow?.remainingPercent !== 0) throw new Error("measured 0 must stay 0");
