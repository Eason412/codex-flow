目标：让名称整理模块满足下面的契约，交付实现和必要的补充测试。

输入：用当前任务工作目录的绝对路径解析 packages/names/index.mjs 和 packages/names/index.test.mjs，先读这两个文件。独立 worktree 中以该 worktree 的绝对路径为准，不读取主工作区的对应文件。

契约：normalizeNames 接收字符串数组，去掉每项首尾空白、丢弃空字符串，按 toLowerCase() 后的值去重，保留第一次出现的拼写和顺序。空数组返回空数组。输入不是数组，或任何一项不是字符串时抛 TypeError；不改变原数组。该模块不调用 packages/ranges。

边界：只改计划 writes 中的实现和测试。既有测试的断言与期望值保持不变，可补充漏测的边界；不改公共接口、另一模块、根文档或依赖，不安装包，不提交或切换分支。已确定采用上述大小写规则，不添加本地化排序或 Unicode 归一化。

完成：全部契约成立，执行计划中的 checks 并确认通过。按 report schema 回复，summary 三行以内，files 每个文件一句话，偏离和未解决项如实列出。
