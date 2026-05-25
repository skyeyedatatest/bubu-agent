import readline from "readline";

// 串行确认队列：确保同一时刻只有一个确认提示
let queue = Promise.resolve();

export function enqueueConfirm(cmd: string): Promise<boolean> {
  const ticket = queue.then(() => askUser(cmd));
  // 无论成功失败都不阻断队列
  queue = ticket.then(
    () => {},
    () => {},
  );
  return ticket;
}

function askUser(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    console.log(`\n⚠️  敏感操作确认：${cmd}`);
    rl.question("是否执行？(y/N) ", (ans) => {
      rl.close();
      const lower = ans.trim().toLowerCase();
      resolve(lower === "" || lower === "y" || lower === "yes");
    });
  });
}
