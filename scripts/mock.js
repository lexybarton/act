// Run the app with canned AI output (no API key needed): npm run mock
process.env.LLM_MOCK = "1";
process.env.DATA_DIR ||= "data-mock";
await import("../src/server.js");
