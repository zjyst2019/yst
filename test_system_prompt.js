// test_system_prompt.js
// 测试系统提示加载是否完整

const claudeService = require('./services/claude');
const fs = require('fs');

console.log('========== 系统提示加载测试 ==========\n');

// 测试加载系统提示
const testPath = process.env.SYSTEM_PROMPT_FILE || './CLAUDE.md';
console.log('测试文件路径:', testPath);

if (claudeService.loadSystemPrompt(testPath)) {
    const prompt = claudeService.getSystemPrompt();
    const filePath = claudeService.getSystemPromptFilePath();

    console.log('\n--- 加载结果 ---');
    console.log('文件路径:', filePath);
    console.log('内容长度:', prompt.length, '字符');
    console.log('行数:', prompt.split('\n').length, '行');

    console.log('\n--- 前 200 字符 ---');
    console.log(prompt.substring(0, 200));

    console.log('\n--- 后 200 字符 ---');
    console.log(prompt.substring(prompt.length - 200));

    console.log('\n--- 完整内容 ---');
    console.log(prompt);

    // 对比原始文件
    console.log('\n--- 与原始文件对比 ---');
    const originalContent = fs.readFileSync(filePath, 'utf-8');
    console.log('原始文件长度:', originalContent.length, '字符');
    console.log('加载内容长度:', prompt.length, '字符');
    console.log('是否一致:', originalContent === prompt);

    if (originalContent !== prompt) {
        console.log('\n警告: 加载内容与原始文件不一致!');
        console.log('差异位置:');
        for (let i = 0; i < Math.max(originalContent.length, prompt.length); i++) {
            if (originalContent[i] !== prompt[i]) {
                console.log(`位置 ${i}: 原始="${originalContent[i]}" 加载="${prompt[i]}"`);
                if (i > 10) break;
            }
        }
    }
} else {
    console.log('错误: 系统提示文件未找到');
}

console.log('\n========== 测试完成 ==========');