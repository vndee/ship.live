// Set the environment before Express and the application are imported.
process.env.NODE_ENV = "production";
await import("./index.js");

export {};
