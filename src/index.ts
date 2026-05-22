import readline from "readline";
import { agentLoop } from "./agent";

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = await new Promise<string>((resolve) => {
    rl.question("🧑 请输入：", (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });

  if (!prompt) {
    console.log("未输入，退出。");
    process.exit(0);
  }

  await agentLoop(prompt);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
