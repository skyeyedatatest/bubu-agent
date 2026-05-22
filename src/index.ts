import { agentLoop, expandFileReferences } from "./agent";
import { promptWithFileCompletion } from "./input";

async function main() {
  const prompt = await promptWithFileCompletion("🧑 请输入：");

  if (!prompt) {
    console.log("未输入，退出。");
    process.exit(0);
  }

  const expandedPrompt = await expandFileReferences(prompt);
  await agentLoop(expandedPrompt);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
