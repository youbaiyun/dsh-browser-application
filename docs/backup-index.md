# 先看这里

这个文件夹里是**「dsh 浏览器扩展」**项目的全部备份。

版本：**0.3.1**
备份时间：1970-01-01 00:00（自动同步）
原仓库：https://github.com/youbaiyun/dsh-browser-application

---

## 我想做什么？看这张表

| 你想做的事 | 打开哪个文件夹 |
|---|---|
| **装到浏览器里用** | `01-browser-extension` |
| **改代码** | `02-source-code` |
| **上架到 Chrome / Firefox 应用商店** | `03-store-listing` |
| **让 AI 自己排查插件故障** | `04-skill` |
| **看安装步骤、授权、隐私政策** | `05-license-and-docs` |
| **恢复桌面端配置（换机器时用）** | `06-config` |
| **看这个插件到底能碰到什么（安全审计结论）** | `07-trust-model` |

---

## 01-browser-extension

**如果你只是想把这个插件装到浏览器里**，只用看这个文件夹。

```
01-browser-extension\
├── A-load-unpacked-extension-use-this\   ← Chrome/Edge 用这个
├── B-firefox-build\        ← Firefox 用这个
├── C-upload-to-chrome-store-0.3.1.zip    ← 上传到 Chrome 商店的
└── D-upload-to-firefox-store-0.3.1-firefox.zip  ← 上传到 Firefox 商店的
```

**⚠️ 一个容易搞错的点：** 如果只是自己用，**不要**用那两个 ZIP。ZIP 是给商店上传的。自己装浏览器要选**文件夹**——在 `chrome://extensions` 里点「加载已解压的扩展程序」，然后选 `01-browser-extension/A-load-unpacked-extension-use-this` 这个文件夹。

**装完记得固定到工具栏**——新装的扩展不会自动出现，它藏在地址栏右边的拼图图标里。详细步骤见 `05-license-and-docs/INSTALL-guide-read-this-first.md`。

---

## 02-source-code

```
02-source-code\
└── dsh-browser-application-0.3.1-full-source\    ← 完整仓库，含 git 提交历史
```

**这里面没有 `node_modules`**（依赖装完有 600MB，没必要备份）。想编译的话，进去跑一条命令就会自动装：

```sh
pnpm install
```

**改完代码必须做两件事，否则看不到变化：**

1. 重新构建：`pnpm --filter dsh-browser-extension run build`
2. 在 `chrome://extensions` 点扩展卡片上的**刷新按钮**

**如果是改桌面端插件（`packages/browser/bridge-browser/`），还要重启桌面端** —— 插件只在启动时读一次，禁用再启用不会重新读。

**目录说明：**

| 路径 | 是什么 | 谁写的 |
|---|---|---|
| `extensions/dsh-browser/control/` | 浏览器侧边栏界面 | **本分支重写** |
| `extensions/dsh-browser/src/content/` | 页面快照与动作执行 | 上游 |
| `extensions/dsh-browser/src/security/` | 授权与信任模型 | 上游 |
| `packages/browser/bridge-browser/` | 桌面端桥接插件 | 上游 |
| `skills/dsh-browser-Application-troubleshooting/` | 排障技能包 | **本分支写的** |
| `benchmark/` | 性能基准测试 | 上游 |
| `scripts/` | 安装脚本、图标生成、布局检查、备份同步 | 混合 |
| `docs/` | 信任模型文档 | **本分支写的** |

哪一行是谁的，`05-license-and-docs/COPYRIGHT-who-owns-what.md` 有完整清单。

---

## 03-store-listing

```
03-store-listing\
├── listing-copy-name-summary-description.md      ← 复制粘贴到商店表单
├── permission-and-data-disclosure.md            ← 商店要求逐条解释每个权限
├── publishing-steps-and-pitfalls.md            ← 完整流程
└── privacy-policy-must-be-public.md         ← 商店强制要求,要给一个公开 URL
```

**上架前有三个坑必须知道：**

1. **隐私政策必须公开可访问。** 商店审核员打不开私有仓库里的文件。可以放成一个 **secret Gist**（不被搜索到，但拿到链接能看）。
2. **ZIP 里要放 `dist/` 的内容，不能多一层目录**，否则报 "manifest not found"。`01` 里的 ZIP 已经打好了。
3. **每次上传，版本号必须比上次高。** 被拒也算占用。下次提交前要把两个 `manifest.json` 里的版本号改掉（两个文件必须一致，有测试盯着）。

---

## 04-skill

```
04-skill\
└── dsh-browser-Application-troubleshooting-SKILL.md
```

**这不是程序，是一份写给 AI 看的排障手册。**

当插件连不上、工具超时、面板空白的时候，AI 读到这份文档就知道该怎么排查。安装桌面端时会自动拷到 `~/.dsh/skills`，所以正常用不到手动操作。

**它的额外价值：** 别人即使没装你的插件，把这份文档丢给 AI，AI 也能帮他们排查——文档被搜到就有用，不像插件要装了才有用。

---

## 05-license-and-docs

```
05-license-and-docs\
├── INSTALL-guide-read-this-first.md          ← 从零到能用,含固定到工具栏那一步
├── README-zh.md
├── README-en.md
├── LICENSE-MIT.txt          ← ⚠️ 不能删,见下
├── COPYRIGHT-who-owns-what.md  ← ⚠️ 不能删
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
└── CODE_OF_CONDUCT.md
```

**为什么 LICENSE 和 COPYRIGHT 不能删：**

这个项目是 [Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser) 的衍生版，MIT 协议要求保留原作者的版权声明。**删掉就失去 MIT 授权，从"合法分叉"变成"侵权"。**

具体哪些代码是谁的，看 `COPYRIGHT-who-owns-what.md`。

---

## 06-config

**这个文件夹是后来补上的，因为它备份的东西不在源码仓库里。**

桌面端的所有插件配置、工作区登记，都住在 `~/.dsh/`（Windows 下是 `%USERPROFILE%\.dsh\`）下。
**源码可以重新 clone，这些配置不会自己回来。**

```
06-config\
├── cordis.patch.yml                    ← 插件配置(模型、技能目录、桥接插件)
├── profile-package.json                ← 装了哪些插件
├── workspace-registry.json             ← 工作区分区和对话的登记
└── README-what-these-are-and-how-to-restore.md   ← 每个文件是什么、怎么恢复
```

**这里记录了一件事**：浏览器侧边栏里的对话归在一个叫 **「浏览器对话」** 的工作区里，
原来的名字是 `browser-sessions`（照目录名自动取的，像个内部细节，不容易认出来），
已手动改成中文。**改完必须重启桌面端才生效** —— 界面只在启动时读一次。

**没备份凭据**：`ext-bridge-token` 和 `.credentials.yaml` 是账号凭据，故意没放进来。

---

## 07-trust-model

```
07-trust-model\
└── TRUST-MODEL-what-it-can-reach.md
```

**把这个插件能碰到什么、不能碰到什么，一条一条写清楚了** —— 联网只连本机、密码卡号不出页面、不截图、不上传文件、没有遥测。

**里面也写了两条容易被误解的能力**（如实记录，不美化）：

1. `host_permissions` 是**所有 http/https 网站** —— 因为扩展没法预知你要操作哪个标签页。**注入范围宽，但权限窄**：只动你绑定的那一个标签页。
2. **桥接地址可以被指向远程主机**（`bridgeUrl` 设置）。面板里不暴露这个字段，改它需要直接改扩展存储。**这是上游的设计**，也是这个插件最不明显的潜在用途。

**如果你只看一份文档决定要不要装**，看这份。

---

## 这个项目是什么

**让桌面端的 dsh（DeepSeek Harness）操作你正在用的浏览器标签页。**

- 就在你当前的页面里干活，**保留你的登录态**
- 网页转成文本给模型看，**全程不截图**
- 点击、输入、跳转**默认都要先问你**
- 密码和卡号**不出页面**
- 对话就在浏览器侧边栏里

**它由两部分组成，缺一不可：**

| 部分 | 装到哪 |
|---|---|
| 浏览器扩展 | 你的浏览器 |
| 桌面端 dsh + 桥接插件 | 你的电脑 |

**所以"装个插件就能用"是不成立的** —— 还得装桌面端。安装步骤见 `05-license-and-docs/INSTALL-guide-read-this-first.md`。

---

## 已知问题（如实记录，不藏着）

| 问题 | 影响 |
|---|---|
| `pnpm run test:smoke` 在 DSH 0.2.0-rc.2 上失败 | 上游会话清理行为，与本项目改动无关。CI 里已设为「只报告不拦截」 |
| 两个桥接插件测试在 Windows 上失败 | 平台限制：Windows 报不出 POSIX `0600` 权限位，创建目录符号链接需要提权 |
| 扩展的 16px 图标偏密 | DeepSeek 鲸鱼标志本身细节多，在 16px 下每笔约合 1 像素。工具栏实际显示 32px，那个清晰 |

---

## 快速自检：这份备份是完整的吗

在 `02-source-code/dsh-browser-application-0.3.1-full-source/` 里跑：

```sh
git log --oneline -1
```

**再和原仓库比一下**（把路径换成你自己的 checkout）：

```sh
git -C "<原仓库路径>" rev-parse HEAD
```

**两个哈希对得上，就说明这份备份和原仓库完全一致。**
