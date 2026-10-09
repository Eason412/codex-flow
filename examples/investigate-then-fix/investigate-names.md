目标：收集名称模块测试失败的原因证据，供 Claude 决定修法。只分析，不修改文件。

输入：用当前任务工作目录的绝对路径解析 packages/names/index.mjs 和 packages/names/index.test.mjs，读实现与全部测试。执行 node --test packages/names/index.test.mjs，核对报错输入、实际值和测试期望，说明是哪段实现引入了差异。

边界与停止条件：仅调查该模块，最多运行测试两次；收集到全部失败用例与对应实现位置即停止。测试通过时如实报告未复现，不制造问题。不修代码、不改测试、不写报告文件、不调查另一模块，不安装包或操作 git。

完成：每个失败都有可复现的命令与源码位置，事实和未验证判断分开。测试的非零退出码是定位证据，不是本只读任务的失败。按 report schema 返回，files 留空；summary 三行以内说明主要差异，deviations 记录未能完成的核对，open_issues 写需要 Claude 判断的问题。
