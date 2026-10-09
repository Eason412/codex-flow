目标：让区间计算模块满足下面的契约，交付实现和必要的补充测试。

输入：用当前任务工作目录的绝对路径解析 packages/ranges/index.mjs 和 packages/ranges/index.test.mjs，先读这两个文件。

契约：intersectRanges 接收两个半开区间 [start, end)，每个区间用长度为 2 的数组表示，端点是有限数且 start <= end。返回交集 [start, end]；没有交集、仅接触端点或任一区间为空时返回 null。无效输入抛 TypeError，包括 NaN、Infinity、反向区间和错误数组长度。不改变输入数组。该模块不调用 packages/names。

边界：只改计划 writes 中的实现和测试。既有测试的断言与期望值保持不变，可补充漏测的边界；不改公共接口、另一模块、根文档或依赖，不安装包，不提交或切换分支。已确定使用半开区间，不改成闭区间，不增加区间合并或日期解析功能。

完成：全部契约成立，执行计划中的 checks 并确认通过。按 report schema 回复，summary 三行以内，files 每个文件一句话，偏离和未解决项如实列出。
