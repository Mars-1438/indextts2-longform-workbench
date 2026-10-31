"""长篇台本 · 智能导入（按文本特征分 5 类，每类各一套切分/分组策略）

思路换了：先**看文本长什么样**，再决定怎么切、怎么分组、怎么算延迟。

    inspect(文件) → 中间源（text / blocks / cues / rows）
    detect(中间源) → 5 类里选一个（带置信度与证据，前端可手动改）
    plan(中间源, 类别, 选项) → groups[{name, segments[{text,note,t0,t1,pause,i}]}]

5 类（按优先级）：
    1. timeline  时间轴类   有绝对时间码（srt / [00:01:23] 行首 / 整行的 00:12）
    2. script    剧本类     有显式角色前缀（「阿澈：」或角色名单独一行 + 台词 / fountain）
    3. novel     小说类     含成对引号对白（「」『』“”""）
    4. tag       指令类     有【镜头 x】/【停顿 3 秒】这类标签，或强换行（一行一句）
    5. plain     纯文本     全无特征时的兜底

公共原则：
  · 分段绝不在引号 / 括号内部硬切；超长又找不到安全切点就保留原文并标 over，交给人拆；
  · 每个分段带 i（原文出现顺序），分组只影响归类、不影响顺序；
  · 时间码只做 t0/t1（出现时间）与 pause（延迟），不进正文；
  · 标签 / 动作 / 场景这类不朗读的东西进 note，或按选项丢弃。
"""

import csv
import io
import re
import zipfile
from xml.etree import ElementTree as ET

MAX_SEG_CHARS = 300          # 单段硬上限（IndexTTS 一行建议 ≤120 token ≈ 90 字）
DEFAULT_SEG_CHARS = 70
PAUSE_CAP_DEFAULT = 30000

# ---------------------------------------------------------------- 基础正则
OPEN_BR = "「『“‘（(【[《〈{"
CLOSE_BR = "」』”’）)】]》〉}"
BR_PAIR = dict(zip(CLOSE_BR, OPEN_BR))
SENT_END = "。！？!?…\n"
SOFT_END = "，、,；;：: "

SPEAKER_RE = re.compile(r"^\s*([\u4e00-\u9fa5A-Za-z0-9_·\- ]{1,12})\s*[：:]\s*(.+)$")
SCENE_RE = re.compile(
    r"^\s*(?:INT\.?|EXT\.?|EST\.?|I/E\.?|内景|外景|内/外|日/夜)\b|"
    r"^\s*(?:INT\.?|EXT\.?)\s|第\s*\d+\s*场|场景\s*\d*", re.I)
CHAPTER_RE = re.compile(
    r"^\s*(?:第\s*[0-9零一二三四五六七八九十百千万]+\s*[章节回幕集篇]|"
    r"chapter\s+\d+|part\s+\d+|#{1,3}\s*\S|序章|楔子|尾声|后记|番外)", re.I)
FORMULA_RE = re.compile(r"(?:[=＝].*[×÷+\-*/^]|\\frac|\\sum|∑|∫|\b[a-zA-Z]\s*=\s*[^，。]{0,20}$|例题|思考题|练习题|习题)")
ACTION_RE = re.compile(r"[（(【\[]([^）)】\]]{0,80})[）)】\]]")
PAREN_RE = re.compile(r"[（(]([^）)]{0,80})[）)]")
PAUSE_RE = re.compile(
    r"[【\[（(]\s*(?:停顿|静默|暂停|停|pause)\s*[:：]?\s*"
    r"([0-9]+(?:\.[0-9]+)?)\s*(毫秒|ms|秒|s)?\s*[】\]）)]", re.I)
PUNCT_RE = re.compile(r"[。！？!?…，,；;：:.、]")

# ---------------------------------------------------------------- 时间码
# 真稿子里的时间码写法很杂，只认「[00:12] 正文」这一种必然漏：
#   · 全角冒号 00：12、半角句点当毫秒 00:01:23.456
#   · 破折号 / 箭号当区间 00:12-00:15、00:12→00:15、00:12~00:15、00:12 至 00:15
#   · 单位写法 1 时 2 分 3 秒、2 分 3 秒、3.5 秒、1'23"
#   · 时间码和正文挤在同一行：00:12台词、[00:12]台词（无空格）、台词 00:12
#   · 四段时间 00:00:01:12（最后一节当帧，帧率可调）
# 做法：先把全角标点折成半角得到「影子串」（1:1 translate，下标与原文严格对齐），
# 在影子串上找候选并校验范围，再按区间 / 行首 / 行尾 / 行内判定归宿，
# 最后按原文下标把时间码切掉——正文一个字都不改。
_TC_FOLD = str.maketrans({
    "：": ":", "︰": ":", "∶": ":", "；": ";", "﹔": ";",
    "，": ",", "﹐": ",", "．": ".", "｡": ".",
    "－": "-", "—": "-", "–": "-", "―": "-", "─": "-",
    "～": "~", "〜": "~", "＇": "'", "’": "'", "′": "'", "″": '"', "＂": '"',
    "　": " ", "【": "[", "】": "]", "〔": "[", "〕": "]",
    "（": "(", "）": ")", "｛": "{", "｝": "}", "｜": "|",
    "＞": ">", "＜": "<",
})

# 候选时间码（宽松）：能不能当真还得过 _tc_seconds 的范围校验
_TC_RE = re.compile(r"""
    (?<![\d:;.,'’])
    (?:
        \d{1,3}\s*[:;]\s*\d{1,2}\s*[:;]\s*\d{1,2}(?:\s*[:;.,]\s*\d{1,3})?   # 时:分:秒[.毫秒|:帧]
      | \d{1,3}\s*:\s*\d{1,2}(?:\s*[.,]\s*\d{1,3})?                        # 分:秒[.毫秒]
      | \d{1,2}\s*-\s*\d{1,2}\s*-\s*\d{1,2}(?:\s*-\s*\d{1,3})?              # 时-分-秒[-毫秒]
      | \d{1,2}\s*(?:小时|时|h)\s*(?:\d{1,2}\s*(?:分|min|m)\s*)?
        (?:\d{1,2}(?:\.\d+)?\s*(?:秒|sec|s)?)?                               # 1时2分3秒
      | \d{1,3}\s*(?:分|min)\s*\d{1,2}(?:\.\d+)?\s*(?:秒|sec|s)?            # 2分3秒
      | \d{1,3}(?:\.\d+)?\s*(?:秒|sec|s)(?![\w])                            # 3.5秒
      | \d{1,2}\s*'\s*\d{1,2}(?:[."]\d{1,3})?["″]?                           # 1'23"45
    )
    (?![\d])
""", re.X | re.I)

# 兼容旧名字（只保留给外部/老测试读，识别逻辑已经全部走上面的 _TC_RE + parse_timeline）
TC_TIME = r"\d{1,3}[:;]\d{1,2}(?::\d{1,2})?(?:[.,:]\d{1,3})?"
TC_ONLY_RE = re.compile(r"^\s*[\[【(（]?\s*(" + TC_TIME + r")\s*[\]】)）]?\s*$")
TC_START_RE = re.compile(r"^\s*[\[【(（]?\s*(" + TC_TIME + r")\s*[\]】)）]?\s*(.*\S)\s*$")

_TC_BR_OPEN = "[({【（〔<"
_TC_BR_CLOSE = "])}】）〕>"
_TC_LEAD_JUNK = " \t-–—~|｜:：、,，.。;；>"
_TC_JOIN_RE = re.compile(r"(?:[-–—~～→⇒>|｜]|to|至|到)+", re.I)

# 指令标签：【镜头 1】[画面 3]〔音效〕
TAG_ANY_RE = re.compile(r"[【\[]([^】\]\n]{1,30})[】\]]|〔([^〕\n]{1,30})〕")
TAG_KW_RE = re.compile(
    r"镜头|画面|分镜|特写|远景|近景|中景|淡入|淡出|闪回|转场|字幕|旁白|"
    r"第\s*[0-9一二三四五六七八九十]+\s*[格页话幕场集]|"
    r"停顿|静默|暂停|bgm|b\.g\.m|音乐|音效|配乐|画师|作画|备注|注\s*[:：]|"
    r"音[乐效]|插曲|片头|片尾", re.I)
TAG_GROUP_RE = re.compile(r"镜头|画面|分镜|第\s*[0-9一二三四五六七八九十]+\s*[格页话幕场集]|章|篇", re.I)


# ---------------------------------------------------------------- 选项 schema
def _o(k, label, typ, default, values=None, hint="", lo=None, hi=None, step=None):
    d = {"k": k, "label": label, "type": typ, "def": default}
    if values:
        d["values"] = [list(v) for v in values]
    if hint:
        d["hint"] = hint
    if lo is not None:
        d["min"] = lo
    if hi is not None:
        d["max"] = hi
    if step is not None:
        d["step"] = step
    return d


CLASSES = [
    {
        "id": "timeline", "name": "时间轴类", "icon": "⏱",
        "desc": "有绝对时间码：srt、[00:01:23] 行首、整行的 00:12、与正文同一行的时间码",
        "detail": (
            "**怎么认出来的（比只认「行首」宽得多）**\n"
            "只要一行里出现时间码，就按「时间轴类」处理。认这些写法：\n"
            "· 时:分:秒 / 时:分:秒,毫秒 / 时:分:秒.毫秒 / 时:分:秒:帧（帧率可调）\n"
            "· 分:秒、分:秒.毫秒（00:12、1:02.5）\n"
            "· 时-分-秒（00-01-23，剪辑软件常这么导）\n"
            "· 单位写法：1 时 2 分 3 秒、2 分 3 秒、3.5 秒、1'23\"12\n"
            "· 全角标点：00：12、00：00：01，200；全角括号【00:12】\n"
            "· 区间：00:12-00:15、00:12→00:15、00:12~00:15、00:12 至 00:15、00:12 --> 00:15\n"
            "· 和正文挤在同一行：00:12台词、[00:12]台词（没空格）、台词 00:12\n"
            "· srt 缺序号、序号后没有空行、一条字幕里好几行正文\n\n"
            "**位置策略**\n"
            "默认「自动」：只认行首 / 行尾（避免把「约在 12:30 见面」这种正文里的钟点当时间码）。\n"
            "如果时间码夹在句子中间，把「时间码位置」改成「行内任意位置」。\n\n"
            "**这一类怎么切**\n"
            "一条时间码 = 一段。时间码只当属性，绝不出现在正文里。\n\n"
            "**延迟怎么算（智能）**\n"
            "先算相邻两条之间的空档 = 下一条开始 − 上一条结束：\n"
            "· 小于 120ms：算 0（字幕连排，硬加停顿会拖慢）\n"
            "· 120ms ~ 3000ms：原样保留（这就是配音的呼吸缝）\n"
            "· 超过 3000ms：截到 3000ms（多半是换镜头，全按原样会让整体越拖越长）\n\n"
            "**出现时间**\n"
            "每条的开始/结束时间记到行上（t0/t1），进时间轴按它落位，配音改完能直接对齐画面。\n\n"
            "**还是没认全？**\n"
            "在「自定义时间码格式」里贴一个你稿子里的时间码样例（如 `[00:12]`、`00:12:03,200`），\n"
            "或写一条正则（第 1 个括号 = 开始，第 2 个 = 结束），点「校验」马上能看到认出多少处。"
        ),
        "hints": ["时间码不进正文", "行首/行尾/同行都能认", "空档 → 延迟（阈值可调）",
                  "出现时间写进 t0/t1", "支持自定义时间码格式"],
        "sample": (
            "1\n00:00:01,000 --> 00:00:03,200\nHello, world.\n你好，世界。\n\n"
            "2\n00:00:03,900 --> 00:00:06,500\nThis is a test.\n这是一个测试。\n\n"
            "3\n00:00:07,000 --> 00:00:09,800\nGoodbye.\n再见。\n"
        ),
        "default_group": "none", "default_max": 70,
        "group_opts": [["none", "不分组"], ["lang", "按语种"], ["speaker", "按说话人"],
                       ["part", "按时间段"]],
        "opts": [
            _o("tc_custom", "自定义时间码格式", "text", "",
               hint="贴一个稿子里的时间码样例（如 [00:12] 或 00:12:03,200），也可写正则"
                    "（第 1 个括号=开始，第 2 个=结束）；留空=用内置全格式识别"),
            _o("tc_pos", "时间码位置", "select", "auto",
               [["auto", "自动（行首 / 行尾）"], ["head", "只认行首"],
                ["any", "行内任意位置（稿子里夹在句中）"]],
               "自动最稳；正文里有「约在 12:30 见面」这种钟点时，别选行内"),
            _o("tc_fps", "帧率（四段时间的最后一节当帧）", "number", 25, lo=1, hi=240, step=1,
               hint="00:00:01:12 这种最后是帧号，帧率不对会差几十毫秒"),
            _o("gap_mode", "延迟策略", "select", "smart",
               [["smart", "智能（按空档判断）"], ["fixed", "固定值"], ["none", "不加延迟"]],
               "智能 = 小空档忽略、正常空档照搬、超长空档截断"),
            _o("gap_min", "空档小于这个就忽略(ms)", "number", 120, lo=0, hi=2000, step=10),
            _o("gap_max", "空档超过这个就截断(ms)", "number", 3000, lo=200, hi=30000, step=100),
            _o("gap_scale", "空档系数", "number", 1.0, lo=0.2, hi=2.0, step=0.05,
               hint="整体想快一点调到 0.8，想慢一点调到 1.2"),
            _o("fixed_ms", "固定延迟(ms)", "number", 400, lo=0, hi=10000, step=50,
               hint="只在「固定值」策略下生效"),
            _o("part_seconds", "按时间段分组：每组秒数", "number", 60, lo=10, hi=600, step=10),
            _o("use_t0", "记下出现时间（时间轴按它落位）", "bool", True),
            _o("bilingual_split", "一条字幕里中英两行 → 拆成两条", "bool", True),
            _o("lang_keep", "只保留", "select", "both",
               [["both", "两种都要"], ["cjk", "只要中文"], ["latin", "只要外文"]],
               "只配一种语言时选一个，另一行直接丢掉"),
            _o("merge_short", "极短字幕（≤4 字）并到上一段", "bool", False),
        ],
        "presets": [
            {"name": "标准字幕配音", "opts": {}},
            {"name": "双语分开配", "opts": {"group_by": "lang", "bilingual_split": True}},
            {"name": "只要中文", "opts": {"lang_keep": "cjk"}},
            {"name": "时间码夹在句中", "opts": {"tc_pos": "any"}},
            {"name": "长片分段（每 2 分钟一组）", "opts": {"group_by": "part", "part_seconds": 120}},
        ],
    },
    {
        "id": "script", "name": "剧本类", "icon": "🎭",
        "desc": "有显式角色前缀：「阿澈：…」，或角色名单独一行跟着台词",
        "detail": (
            "**怎么认出来的**\n"
            "出现多个「名字：台词」前缀；或「单独一行的短名字 + 紧跟台词」（fountain、中文台词稿常见）；\n"
            "或 INT./EXT./第 3 场 这类场景头。\n\n"
            "**这一类怎么切**\n"
            "角色名不进正文，只用来分组 / 记备注；同一角色连着说几句会合并到单段上限（可关）；\n"
            "换人、换场必断。\n\n"
            "**场景与动作**\n"
            "· 场景头默认写进备注，不朗读；\n"
            "· 括号动作（（收伞）（雨声））默认写进备注，也可以整段丢弃；\n"
            "· 「阿澈（低声）」里的括号会自动剥掉，单独记备注。\n\n"
            "**分组**：按角色 / 按场景 / 场景+角色 / 按章节 / 不分组。"
        ),
        "hints": ["角色名不进正文", "同角色连说自动合并", "场景/动作转备注", "按角色或场景分组"],
        "sample": (
            "Title: 雨夜咖啡馆\nAuthor: 示例\n\n# 第一场\n\nINT. 咖啡馆 - 夜\n\n"
            "（雨声，门铃响）\n\n店员\n欢迎光临。\n\n阿澈\n（收起伞）\n一杯热美式，谢谢。\n\n"
            "店员\n要加糖吗？\n\n阿澈\n不用，谢谢。\n"
        ),
        "default_group": "role", "default_max": 70,
        "group_opts": [["role", "按角色"], ["scene", "按场景"], ["scene_role", "场景 + 角色"],
                       ["chapter", "按章节"], ["none", "不分组"]],
        "opts": [
            _o("role_style", "角色写法", "select", "auto",
               [["auto", "自动判断"], ["colon", "行内「名字：台词」"], ["line", "角色名单独一行"]],
               "自动会数两种写法的比例，取多的那种"),
            _o("merge_same_role", "同一角色连说的几句合并", "bool", True),
            _o("role_note", "备注里带上「角色：X」", "bool", False),
            _o("scene_note", "场景头写进备注（不朗读）", "bool", True),
            _o("action_note", "括号动作写进备注", "bool", True,
               "关掉就整段丢弃动作提示"),
            _o("paren_name", "剥掉角色名后的括号提示", "bool", True,
               "「阿澈（低声）」→ 角色 阿澈，提示「低声」记备注"),
        ],
        "presets": [
            {"name": "短剧 / 广播剧", "opts": {"group_by": "role", "action_note": True}},
            {"name": "按场景排", "opts": {"group_by": "scene"}},
            {"name": "动态漫（格 + 角色）", "opts": {"group_by": "scene_role", "max_chars": 40}},
            {"name": "播客 / 访谈", "opts": {"group_by": "role", "merge_same_role": False,
                                            "max_chars": 110}},
        ],
    },
    {
        "id": "novel", "name": "小说类", "icon": "📖",
        "desc": "含成对引号对白：「…」『…』“…”\"…\"",
        "detail": (
            "**怎么认出来的**\n"
            "成对引号出现 ≥2 次 —— 小说里「引号 = 台词」，这是最稳的特征。\n"
            "除了「」『』“”‘’，**方括号 / 书名号 / 花括号**也认：`[台词]`、`【台词】`、`《台词》`、`{台词}`，\n"
            "以及竖排用的 ﹁﹂﹃﹄ ｢｣（`[00:12]`、`[镜头 3]`、`[叹气]` 这种会被排除，不当台词）。\n"
            "符号还能自己指定：选项里「对白符号」留空 = 全部常见符号，写 `[]【】` = 只认这两种。\n\n"
            "**这一类怎么切**\n"
            "· 引号里的内容**单独成段**（当台词），引号外的叙述留在旁白段；\n"
            "· 括号里的内容（心理活动 / 动作）也能单独成句，或只记备注不朗读；\n"
            "· 一句里既有叙述又有台词时，会在引号边界切开，不会把台词和旁白粘在一起。\n\n"
            "**分组**：按章节 / 按「旁白·台词」/ 章节+旁白台词 / 按角色（对白 A/B）/ 不分组。\n"
            "想让旁白一个音色、台词另一个音色，就选「旁白 / 台词」分组。\n\n"
            "**没有角色标注的对白稿**（整行都是「…」、几乎没有旁白）：\n"
            "自动按台词顺序**奇偶交替**分成「角色A / 角色B」两组，各组一个音色就能配出两个人的对话；\n"
            "猜错了就改组名、或逐句改归属，整份反了用「⇄ 交换 A/B」。"
        ),
        "hints": ["引号内单独成段", "括号可单独成句或转备注", "纯对白稿自动分角色 A/B"],
        "sample": (
            "第一章 起点\n\n夜色渐深，城市的灯一盏盏亮起来。他推开门，听见有人轻声说："
            "「你终于来了。」\n\n「进来吧，外面冷。」她把门让开，顺手接过他手里的伞。\n\n"
            "第二章 转折\n\n他站在窗前，很久没有说话。（他在想那封信的事。）\n"
        ),
        "default_group": "chapter", "default_max": 80,
        "group_opts": [["chapter", "按章节"], ["kind", "旁白 / 台词"],
                       ["chapter_kind", "章节 + 旁白台词"], ["speaker", "按角色（对白 A/B）"],
                       ["chapter_speaker", "章节 + 角色"], ["none", "不分组"]],
        "opts": [
            _o("speaker_mode", "对白分角色", "select", "auto",
               [["auto", "自动（纯对白稿才分）"], ["alt2", "双人交替 A/B"], ["off", "不分角色"]],
               "没有「角色：」标注时按台词顺序交替给 角色A / 角色B。"
               "想按旁白里的名字认人（「李四说」），用上面那颗「🧠 高级识别」按钮 —— "
               "它是独立开关，默认不开；分完都能在预览里改角色名、单句改归属"),
            _o("quote_split", "引号里的内容单独成段", "bool", True),
            _o("quote_pairs", "对白符号（可自定义）", "text", "",
               "留空 = 认全部常见符号：「」『』“”‘’\"\" ﹁﹂﹃﹄ ｢｣ []［］【】〔〕〖〗《》〈〉{}｛｝；"
               "只认某几种就写 `[]【】`；符号本身有空格用 `[ ] | 【 】`；写 none 一个都不认"),
            _o("paren_split", "括号里的内容单独成句", "bool", True,
               "心理活动 / 动作提示单独成句；不想念出来就把下面「只记备注」勾上"),
            _o("paren_note", "括号内容只记备注（不朗读）", "bool", False),
            _o("keep_marks", "保留引号字符", "bool", True,
               "关掉会把「」“”去掉，只读字"),
            _o("chapter_mode", "章节识别", "select", "auto",
               [["auto", "自动（第 x 章 / # 标题）"], ["hash", "只认 # 标题"],
                ["blank", "空行分章"], ["off", "不认章节"]]),
            _o("merge_narration", "相邻旁白短句合并", "bool", True),
        ],
        "presets": [
            {"name": "有声书", "opts": {"group_by": "chapter"}},
            {"name": "旁白/台词分开配", "opts": {"group_by": "kind"}},
            {"name": "双人对白（A/B 两个音色）",
             "opts": {"group_by": "speaker", "speaker_mode": "alt2"}},
            {"name": "绘本（短句 + 慢速）", "opts": {"group_by": "chapter_kind", "max_chars": 45}},
            {"name": "只读旁白（括号不念）", "opts": {"paren_note": True, "group_by": "chapter"}},
        ],
    },
    {
        "id": "tag", "name": "指令类", "icon": "🏷",
        "desc": "有【镜头 1】/【停顿 3 秒】/〔音效〕这类标签，或一行一句的强换行",
        "detail": (
            "**怎么认出来的**\n"
            "出现【镜头】【画面】【第 3 格】【停顿 2 秒】【BGM】这类方括号标签；\n"
            "或者几乎所有行都很短（一行一句），说明这个稿子是用换行当结构用的。\n\n"
            "**这一类怎么切**\n"
            "· 标签不朗读：【镜头 3】可以当分组、当备注、或直接丢弃；\n"
            "· 【停顿 3 秒】/（静默 5s）转成真正的静默时长（最多 30 秒）；\n"
            "· 强换行时一行一段、不合并（合并会毁掉提示音/解说的节奏）。\n\n"
            "**分组**：按标签（镜头/分格/标题）、按章节、不分组。"
        ),
        "hints": ["标签不朗读，可当分组或备注", "停顿标签 → 静默", "一行一段不合并"],
        "sample": (
            "【镜头 1】清晨的城市航拍，车流像一条发亮的河。\n"
            "【镜头 2】老人在巷口支起摊子，热气从锅里冒出来。（环境音：街市）\n"
            "【镜头 3】他抬头看了看天，把手套又紧了紧。\n"
            "【停顿 2 秒】\n"
            "【镜头 4】画面渐暗。\n"
        ),
        "default_group": "tag", "default_max": 60,
        "group_opts": [["tag", "按标签分组"], ["chapter", "按章节"], ["none", "不分组"]],
        "opts": [
            _o("tag_mode", "标签怎么处理", "select", "note",
               [["note", "写进备注（不朗读）"], ["group", "当分组名"], ["drop", "直接丢掉"],
                ["keep", "留在正文里"]],
               "「当分组名」= 用【镜头 3】这种标签把句子分组"),
            _o("pause_tags", "识别停顿标签并转成静默", "bool", True),
            _o("pause_cap", "停顿上限(ms)", "number", 30000, lo=1000, hi=60000, step=1000),
            _o("paren_note", "圆括号内容写进备注", "bool", True),
            _o("line_strict", "一行一段（强换行，不合并）", "bool", True),
            _o("merge_short_lines", "把过短的行并到下一行", "bool", False,
               "只在关掉「一行一段」时有意义"),
        ],
        "presets": [
            {"name": "短视频 / 纪录片解说", "opts": {"tag_mode": "note", "group_by": "tag"}},
            {"name": "按镜头分组", "opts": {"tag_mode": "group", "group_by": "tag"}},
            {"name": "动态漫（按分格）", "opts": {"tag_mode": "group", "group_by": "tag", "max_chars": 40}},
            {"name": "IVR / 提示音（一行一条）", "opts": {"line_strict": True, "group_by": "none",
                                                          "max_chars": 120}},
        ],
    },
    {
        "id": "plain", "name": "纯文本", "icon": "🧩",
        "desc": "没有时间码 / 角色前缀 / 引号 / 标签，按句子长度切",
        "detail": (
            "**什么时候用它**\n"
            "前面四类的特征都没检测到（或者你想完全自己控制）。\n\n"
            "**这一类怎么切**\n"
            "· 按长度：切句后合并到单段上限（最通用，一行读一段完整的话）；\n"
            "· 一句一行：严格一个句号一句，不再合并（适合逐句精修）；\n"
            "· 一段一行：按空行分段，每段一段（适合已经排好版的口播稿）。\n\n"
            "**分组**：不分组 / 按章节 / 每 N 段一组（长文想分批生成时用）。"
        ),
        "hints": ["按句切分后合并到上限", "绝不在引号中间硬切", "可按章节或每 N 段分组"],
        "sample": (
            "第一章 开场\n\n这是一段普通的口播稿。它没有时间码，也没有角色前缀，"
            "更没有引号和标签。\n\n所以只能按句子切开，再合并到每段不超过上限。\n"
        ),
        "default_group": "none", "default_max": 70,
        "group_opts": [["none", "不分组"], ["chapter", "按章节"], ["every_n", "每 N 段一组"]],
        "opts": [
            _o("seg_mode", "分段方式", "select", "length",
               [["length", "按长度（切句后合并）"], ["sentence", "一句一行"],
                ["paragraph", "一段一行（按空行）"]]),
            _o("group_n", "每 N 段一组", "number", 20, lo=2, hi=200, step=1,
               hint="分组方式选「每 N 段一组」时生效"),
            _o("chapter_mode", "章节识别", "select", "auto",
               [["auto", "自动（第 x 章 / # 标题）"], ["hash", "只认 # 标题"], ["off", "不认章节"]]),
            _o("pause_per_para", "每段后加停顿(ms)", "number", 0, lo=0, hi=5000, step=50),
        ],
        "presets": [
            {"name": "口播稿（按长度）", "opts": {}},
            {"name": "逐句精修（一句一行）", "opts": {"seg_mode": "sentence"}},
            {"name": "按段落", "opts": {"seg_mode": "paragraph"}},
            {"name": "长文分批（每 30 段一组）", "opts": {"group_by": "every_n", "group_n": 30}},
        ],
    },
]

CLASS_MAP = {c["id"]: c for c in CLASSES}
CLASS_ORDER = [c["id"] for c in CLASSES]

GROUP_LABELS = {
    "none": "不分组", "role": "角色", "scene": "场景", "scene_role": "场景 + 角色",
    "chapter": "章节", "kind": "旁白 / 台词", "chapter_kind": "章节 + 旁白台词",
    "speaker": "说话人", "part": "时间段", "tag": "标签", "every_n": "每 N 段",
    "lang": "语种",
}


# ---------------------------------------------------------------- 文本工具
def _text_health(text):
    """粗略判断「这真的是文字吗」：返回可读字符占比（0~1）。"""
    if not text:
        return 0.0
    sample = text[:20000]
    bad = sum(1 for ch in sample if ch == "\ufffd" or (ord(ch) < 32 and ch not in "\n\r\t"))
    return 1.0 - bad / max(1, len(sample))


def _decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "gb18030", "utf-16"):
        try:
            return data.decode(enc)
        except Exception:  # noqa: BLE001
            continue
    return data.decode("utf-8", "replace")


def _is_cjk(s):
    return bool(re.search(r"[\u4e00-\u9fa5]", s or ""))


def _norm_space(s):
    return re.sub(r"[ \t\u3000]+", " ", (s or "").replace("\r", "")).strip()


def _num(v, default, lo=None, hi=None):
    try:
        f = float(v)
    except (TypeError, ValueError):
        f = float(default)
    if lo is not None:
        f = max(lo, f)
    if hi is not None:
        f = min(hi, f)
    return f


def _clamp_ms(v, lo=0, hi=PAUSE_CAP_DEFAULT):
    return int(max(lo, min(hi, int(round(_num(v, 0, lo, hi))))))


def split_smart(text, max_chars=DEFAULT_SEG_CHARS, no_merge=False):
    """按语义分段：先按句末标点切，再按上限合并（引号/括号内部不切）。"""
    text = (text or "").strip()
    if not text:
        return []
    max_chars = max(12, int(max_chars or DEFAULT_SEG_CHARS))

    depth = 0
    parts, buf = [], []
    for ch in text:
        buf.append(ch)
        if ch in OPEN_BR:
            depth += 1
        elif ch in CLOSE_BR:
            depth = max(0, depth - 1)
        if depth == 0 and ch in SENT_END:
            parts.append("".join(buf).strip())
            buf = []
    rest = "".join(buf).strip()
    if rest:
        parts.append(rest)
    parts = [p for p in parts if p]
    if not parts:
        return []

    out, cur = [], ""
    for seg in parts:
        if no_merge:
            out.append({"text": seg, "over": len(seg) > max_chars})
            continue
        if not cur:
            cur = seg
        elif len(cur) + len(seg) <= max_chars:
            cur += seg
        else:
            out.append({"text": cur, "over": False})
            cur = seg
    if cur:
        out.append({"text": cur, "over": len(cur) > max_chars})

    final = []
    for item in out:
        s = item["text"]
        if len(s) <= max_chars * 1.6:
            final.append(item)
            continue
        for piece in _split_soft(s, max_chars):
            final.append({"text": piece, "over": len(piece) > max_chars})
    return [x for x in final if x["text"].strip()]


def _split_soft(s, max_chars):
    """超长句：优先在深度 0 的句末/逗号处切；没有安全切点就整段保留（标 over）。"""
    out, buf, depth = [], "", 0
    for ch in s:
        buf += ch
        if ch in OPEN_BR:
            depth += 1
        elif ch in CLOSE_BR:
            depth = max(0, depth - 1)
        if depth == 0 and (ch in SENT_END or ch in SOFT_END) and len(buf) >= max_chars * 0.45:
            out.append(buf.strip())
            buf = ""
    if buf.strip():
        out.append(buf.strip())

    res = []
    for piece in out:
        while len(piece) > max_chars:
            cut = _safe_cut(piece, max_chars)
            if cut <= 0:
                break
            res.append(piece[:cut].strip())
            piece = piece[cut:].lstrip()
        if piece.strip():
            res.append(piece.strip())
    return res


def _safe_cut(text, limit):
    """在 [0, limit] 里找最靠后的「括号深度 0」位置，找不到返回 -1。"""
    depth = 0
    best = -1
    for i, ch in enumerate(text[:limit + 1]):
        if ch in OPEN_BR:
            depth += 1
        elif ch in CLOSE_BR:
            depth = max(0, depth - 1)
        elif depth == 0 and (ch in SENT_END or ch in SOFT_END or ch == " "):
            best = i + 1
    if best > 0:
        return best
    depth = 0
    for i, ch in enumerate(text):
        if ch in OPEN_BR:
            depth += 1
        elif ch in CLOSE_BR:
            depth = max(0, depth - 1)
            if depth == 0 and i >= limit:
                return i + 1
    return -1


def _extract_actions(text, paren_only=False):
    """把括号里的动作/音效抽出来；返回 (正文, 备注列表)。

    paren_only=True 时只剥圆括号，保留【方括号标签】（标签要留在正文里的场景用）。
    """
    notes = []
    pat = PAREN_RE if paren_only else ACTION_RE

    def rep(m):
        inner = _norm_space(m.group(1))
        if inner:
            notes.append(inner)
        return ""

    return _norm_space(pat.sub(rep, text)), notes


def _clean_pause_marks(text, cap_ms=PAUSE_CAP_DEFAULT):
    """【停顿 2 秒】/（停顿 3 秒）→ (去掉标记的正文, 毫秒或 None)。"""
    ms = None

    def rep(m):
        nonlocal ms
        try:
            v = float(m.group(1))
        except (TypeError, ValueError):
            return ""
        unit = (m.group(2) or "秒").lower()
        ms = int(v * 1000) if unit in ("秒", "s") else int(v)
        ms = int(max(0, min(cap_ms, ms)))
        return ""

    return _norm_space(PAUSE_RE.sub(rep, text)), ms


def _tc_fold(s):
    """全角标点折半角（1:1 替换，长度不变，下标仍对得上原文）"""
    return (s or "").translate(_TC_FOLD)


def _tc_seconds(tc, fps=25):
    """把一个时间码解析成秒；不认识返回 None。

    认：00:01:23,456 / 00:01:23.456 / 00:01:23:12(帧) / 01:23 / 1:02:03 /
        1:02:03-200 / 1时2分3秒 / 2分3秒 / 3.5秒 / 1'23"12
    """
    if not tc:
        return None
    s = _tc_fold(str(tc)).strip()
    s = re.sub(r"\s+", "", s)
    # 掐头去尾：只留「从第一个数字到最后一个数字/单位」这一段，
    # 这样 <00:12> / ##00:12## / T00:12 这类包装都不会干扰解析
    i = next((k for k, ch in enumerate(s) if ch.isdigit()), None)
    if i is None:
        return None
    s = s[i:]
    last = None
    for k in range(len(s) - 1, -1, -1):
        if s[k].isdigit() or s[k] in "时分秒'\"":
            last = k
            break
    if last is None:
        return None
    s = s[:last + 1].rstrip(":;.,、-~|")
    if not s:
        return None
    try:
        fps = max(1.0, float(fps or 25))
    except (TypeError, ValueError):
        fps = 25.0

    # ① 带单位：1时2分3秒 / 2分3秒 / 3.5秒 / 1h2m3s
    if re.search(r"[时分秒]", s) or re.search(r"\d\s*(?:h|m|s|sec|min)\b", s, re.I):
        m = re.fullmatch(
            r"(?:(\d{1,3})(?:小时|时|h))?"
            r"(?:(\d{1,2})(?:分|min|m))?"
            r"(?:(\d{1,2}(?:\.\d+)?)(?:秒|sec|s))?", s, re.I)
        if m and any(g is not None for g in m.groups()):
            h = int(m.group(1) or 0)
            mi = int(m.group(2) or 0)
            se = float(m.group(3) or 0)
            if mi < 60 and se < 60:
                return h * 3600 + mi * 60 + se
        return None

    # ② 1'23" / 1'23"12（最后一节当帧）
    m = re.fullmatch(r"(\d{1,2})'(\d{1,2})(?:[.\"″](\d{1,3}))?[\"″]?", s)
    if m:
        mi, se = int(m.group(1)), int(m.group(2))
        fr = int(m.group(3) or 0)
        if se < 60:
            return mi * 60 + se + fr / fps

    # ③ 时:分:秒[.毫秒 | :帧]
    m = re.fullmatch(
        r"(\d{1,3})[:;](\d{1,2})[:;](\d{1,2})(?:([:;])(\d{1,3})|([.,])(\d{1,3}))?", s)
    if m:
        h, mi, se = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if mi < 60 and se < 60:
            frac = 0.0
            if m.group(5) is not None:          # :帧
                frac = int(m.group(5)) / fps
            elif m.group(7) is not None:        # .毫秒
                frac = int(m.group(7).ljust(3, "0")[:3]) / 1000.0
            return h * 3600 + mi * 60 + se + frac
        return None

    # ④ 分:秒[.毫秒]（第二段 ≥60 时按「时:分」理解）
    m = re.fullmatch(r"(\d{1,3})[:;](\d{1,2})(?:[.,](\d{1,3}))?", s)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        frac = int(m.group(3).ljust(3, "0")[:3]) / 1000.0 if m.group(3) else 0.0
        if b >= 60:
            return a * 3600 + b * 60 + frac
        return a * 60 + b + frac

    # ⑤ 时-分-秒[-毫秒]（剪辑软件导出的另一种写法）
    m = re.fullmatch(r"(\d{1,2})-(\d{1,2})-(\d{1,2})(?:-(\d{1,3}))?", s)
    if m:
        h, mi, se = int(m.group(1)), int(m.group(2)), int(m.group(3))
        fr = int(m.group(4) or 0)
        if mi < 60 and se < 60:
            return h * 3600 + mi * 60 + se + fr / 1000.0
        return None

    # ⑥ 光秃秃的数字（只在自定义格式里会出现）：直接当秒
    m = re.fullmatch(r"(\d{1,6}(?:\.\d+)?)", s)
    if m:
        return float(m.group(1))
    return None


def _tc_join(gap):
    """两个时间码之间只隔着箭头 / 破折号 / 波浪线 / 空白 → 认为是一条区间"""
    g = (gap or "").strip()
    if not g:
        return True
    if len(g) > 8:
        return False
    return bool(_TC_JOIN_RE.fullmatch(g))


def _tc_hits(shadow, fps=25):
    """影子串里所有能通过校验的时间码：[{a,b,sec}]"""
    out = []
    for m in _TC_RE.finditer(shadow):
        txt = m.group(0)
        sec = _tc_seconds(txt, fps)
        if sec is None:
            sec = _tc_seconds(txt.rstrip(":;.,、-~|"), fps)
        if sec is None:
            continue
        out.append({"a": m.start(), "b": m.end(), "sec": sec})
    return out


def _tc_custom_compile(raw, fps=25):
    """把「自定义时间码格式」编译成正则。

    支持两种输入：
      · 正则（含 \\d ( ) [ ] 等元字符）→ 直接用；group(1)=开始，group(2)=结束（可省）
      · 样例（如 [00:12]、00:12:03,200）→ 数字串当通配，整段当一个时间码
    """
    s = (raw or "").strip()
    if not s:
        return None
    try:
        if re.search(r"[\\^$*+?{}\[\](|)]", s):
            return {"re": re.compile(s), "mode": "regex", "raw": s, "fps": fps}
        buf, i, n = "", 0, len(s)
        while i < n:
            ch = s[i]
            if ch.isdigit():
                j = i
                while j < n and s[j].isdigit():
                    j += 1
                buf += r"\d{1,3}"
                i = j
                continue
            buf += re.escape(ch)
            i += 1
        return {"re": re.compile("(" + buf + ")"), "mode": "sample", "raw": s, "fps": fps}
    except re.error as e:  # noqa: BLE001
        raise ValueError(f"时间码格式写错了：{e}")


def _tc_clean_body(txt):
    txt = re.sub(r"\s+", " ", txt or "").strip()
    txt = re.sub(r"^" + "[" + re.escape(_TC_LEAD_JUNK) + r"]+", "", txt)
    return txt.strip()


def _tc_line_custom(orig, cust):
    ms = list(cust["re"].finditer(orig))
    if not ms:
        return None
    m = ms[0]
    gs = [g for g in m.groups() if g]
    tok = gs[0] if gs else m.group(0)
    start = _tc_seconds(tok, cust.get("fps") or 25)
    if start is None:
        return None
    end = None
    if len(gs) > 1:
        s2 = _tc_seconds(gs[1], cust.get("fps") or 25)
        if s2 is not None:
            end = s2
    body = _tc_clean_body(orig[:m.start()] + " " + orig[m.end():])
    return {"start": round(start, 3), "end": round(end, 3) if end is not None else None,
            "text": body}


def _tc_line(orig, pos="auto", fps=25, custom=None):
    """解析一行：能认出时间码就返回 {start, end, text}，否则 None。

    lead  = 时间码在行首（允许前面有空格 / 括号 / 一个序号）
    trail = 时间码在行尾（后面只剩空格 / 括号）
    pos   = "any" 时才接受「句子中间夹着一个时间码」
    """
    if custom:
        return _tc_line_custom(orig, custom)
    sh = _tc_fold(orig)
    hits = _tc_hits(sh, fps)
    if not hits:
        return None

    off = 0
    m = re.match(r"^\s{0,3}\[?\d{1,3}[.、)．\]]\s*", sh)
    if m and hits[0]["a"] >= m.end() - 1:
        off = m.end()                      # 行首序号（1. / 1、/ 1) / [1]）

    first, last = hits[0], hits[-1]
    lead = not sh[off:first["a"]].strip(" \t" + _TC_BR_OPEN)
    trail = not sh[last["b"]:].strip(" \t" + _TC_BR_CLOSE)

    spans, start, end, cut = [], None, None, 0
    if lead and len(hits) > 1 and _tc_join(sh[first["b"]:hits[1]["a"]]):
        start, end = first["sec"], hits[1]["sec"]
        # 整段吃掉（含中间的箭头/破折号），别把「→」留在正文里
        spans = [[first["a"], hits[1]["b"]]]
        cut = hits[1]["b"]
    elif lead:
        start = first["sec"]
        spans = [[first["a"], first["b"]]]
        cut = first["b"]
    elif trail:
        start = last["sec"]
        spans = [[last["a"], last["b"]]]
        cut = last["b"]
    elif (pos or "auto") == "any":
        start = first["sec"]
        spans = [[first["a"], first["b"]]]
        cut = first["b"]
    else:
        return None

    # 行头连着堆了几个时间码（00:12 00:15 正文）→ 一并清掉
    for h in hits:
        if h["a"] < cut and not any(h["a"] == s[0] for s in spans):
            spans.append([h["a"], h["b"]])
    # 包住时间码的括号一起吃掉（【00:12】/ [00:12] / （00:12））
    for sp in spans:
        while sp[0] > 0 and sh[sp[0] - 1] in _TC_BR_OPEN:
            sp[0] -= 1
        while sp[1] < len(sh) and sh[sp[1]] in _TC_BR_CLOSE:
            sp[1] += 1

    src = orig[off:] if off else orig
    shift = -off
    out, pos_last = [], 0
    for a, b in sorted(((max(0, s[0] + shift), max(0, s[1] + shift)) for s in spans)):
        if a < pos_last:
            a = pos_last
        if b <= pos_last:
            continue
        out.append(src[pos_last:a])
        pos_last = b
    out.append(src[pos_last:])
    body = _tc_clean_body(" ".join(out))
    return {"start": round(float(start), 3),
            "end": round(float(end), 3) if end is not None else None,
            "text": body}


def parse_timeline(text, opts=None):
    """把任意「带时间码的文本」切成 cue 列表。

    返回 (cues, stats)。cues 里 start/end 是秒（找不到时间码则是 None），text 是去掉时间码的正文。
    一条时间码 = 一段；时间码单独成行时，后面跟的正文都算这一段的（srt 常规写法）。
    """
    o = dict(opts or {})
    fps = _num(o.get("tc_fps"), 25, 1, 240)
    pos = str(o.get("tc_pos") or "auto")
    custom = _tc_custom_compile(o.get("tc_custom"), fps) if o.get("tc_custom") else None

    raw = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = [x.strip() for x in raw.split("\n")]
    stats = {"lines": 0, "tc": 0, "ranges": 0, "anchors": 0, "fps": fps,
             "custom": bool(custom), "skipped_index": 0}

    # srt 的纯序号行：后面紧跟时间码行 → 丢掉，别当成正文粘到上一段
    keep = []
    for i, s in enumerate(lines):
        if not s:
            continue
        if re.fullmatch(r"\d{1,4}", s):
            nxt = next((x for x in lines[i + 1:] if x), "")
            if nxt and _tc_line(nxt, pos, fps, custom) is not None:
                stats["skipped_index"] += 1
                continue
        keep.append(s)

    cues, cur = [], None
    for s in keep:
        stats["lines"] += 1
        ev = _tc_line(s, pos, fps, custom)
        if ev is None:
            if cur is not None:
                # 用换行粘，不要用空格：字幕一条里两行（中英双语）得留住行结构，
                # 后面「双语拆成两条」才认得出来
                cur["text"] = (cur["text"] + "\n" + s) if cur["text"] else s
            else:
                cues.append({"start": None, "end": None, "text": s})
            continue
        if cur is not None:
            cues.append(cur)
        stats["tc"] += 1
        if ev.get("end") is not None:
            stats["ranges"] += 1
        cur = {"start": ev["start"], "end": ev.get("end"), "text": ev.get("text") or ""}
        if not cur["text"]:
            stats["anchors"] += 1
    if cur is not None:
        cues.append(cur)

    # 补 end：优先用下一条的开始，兜底按字数估
    for i, c in enumerate(cues):
        if c.get("end") is not None:
            continue
        nxt = next((x["start"] for x in cues[i + 1:] if x.get("start") is not None), None)
        if nxt is not None:
            c["end"] = nxt
        elif c.get("start") is not None:
            c["end"] = round(c["start"] + max(1.0, len(c.get("text") or "") / 4.5), 3)
    return [c for c in cues if (c.get("text") or "").strip()], stats


def _fmt_tc(sec):
    sec = max(0, float(sec or 0))
    m, s = divmod(int(sec), 60)
    return f"{m}:{s:02d}"


def _fmt_tc_long(sec):
    """00:01:23.400（校验时间码格式时给人看的）"""
    try:
        v = max(0.0, float(sec))
    except (TypeError, ValueError):
        return "-"
    h, rem = divmod(v, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{s:06.3f}"


# ---------------------------------------------------------------- 台词符号
# 「哪些符号包起来算对白」是一张表，不是硬编码的几种：
#   · 强符号（本身就是引号，内容一律当台词）：「」『』“”‘’""﹁﹂﹃﹄｢｣
#   · 弱符号（借来的方括号 / 书名号 / 花括号，要看内容）：[]［］【】〔〕〖〗《》〈〉{}｛｝
# 弱符号要过 _inner_is_speech()：`[00:12]` 是时间码、`[镜头 3]` 是标签、`[叹气]` 是动作，
# 都不当台词；`[李逍遥！你皮痒啊？]` 才是。
QUOTE_PAIRS = [
    ("「", "」"), ("『", "』"), ("“", "”"), ("‘", "’"), ('"', '"'),
    ("﹁", "﹂"), ("﹃", "﹄"), ("｢", "｣"),
    ("[", "]"), ("［", "］"), ("【", "】"), ("〔", "〕"), ("〖", "〗"),
    ("《", "》"), ("〈", "〉"), ("{", "}"), ("｛", "｝"),
]
STRONG_OPEN = "「『“‘\"﹁﹃｢"
WEAK_OPEN = "[]［］【】〔〕〖〗《》〈〉{｛"
ALL_MARKS = "".join(o + c for o, c in QUOTE_PAIRS)
_TIME_ONLY_RE = re.compile(r"^[\s\d:;.,\-—~'\"→|/]+$")


def _inner_is_speech(inner, strict=True):
    """符号里这一坨像台词吗？

    strict=False（`quote_pairs` 里用户自己写的符号）：只挡「时间码 / 标签词」这两种
    明显不是台词的东西 —— 用户既然说这个符号是对白，短句也算；
    strict=True（内置的弱符号）：还要够长或有句读，免得把 `[叹气]`、`《红楼梦》` 当台词。
    """
    s = (inner or "").strip()
    if not s:
        return False
    if TAG_KW_RE.search(s) or _TIME_ONLY_RE.match(s):
        return False
    if not strict:
        return True
    cjk = len(re.findall(r"[\u4e00-\u9fa5]", s))
    punct = bool(re.search(r"[。！？!?…，、；;：:～~]", s))
    return cjk >= 6 or (cjk >= 2 and punct) or len(s) >= 10


def _quote_pairs(spec=None):
    """把「自定义对白符号」解析成 [(开, 闭)]。

    留空 = 用全部内置符号；写 `none` / `off` / `-` = 一个都不认（只按旁白 / 章节切）。
    支持三种写法：
        `[]【】`        依次两两配成 [] 和 【】
        `[ ] | 【 】`   显式用 | 分隔每一对（符号本身是空格时用这个）
        `§`             单个符号，两边同一个（像 `§台词§`）
    """
    spec = (spec or "").strip()
    if not spec:
        return list(QUOTE_PAIRS)
    if spec.lower() in ("none", "off", "0", "-"):
        return []
    if "|" in spec:
        pairs = []
        for tok in (x.strip() for x in spec.split("|")):
            if not tok:
                continue
            pairs.append((tok[0], tok[1] if len(tok) >= 2 else tok[0]))
        return pairs
    chars = [c for c in spec if not c.isspace()]
    if len(chars) == 1:
        return [(chars[0], chars[0])]
    if len(chars) % 2:
        chars = chars[:-1]
    return [(chars[i], chars[i + 1]) for i in range(0, len(chars), 2)]


def _line_quoted(t, pairs=None):
    """整行是否被某个对白符号包住（且内容确实像台词）。"""
    t = (t or "").strip()
    if len(t) < 3:
        return False
    for o, c in (pairs if pairs is not None else QUOTE_PAIRS):
        if len(t) >= len(o) + len(c) + 1 and t.startswith(o) and t.endswith(c):
            if o in STRONG_OPEN or o == c:
                return True
            return _inner_is_speech(t[len(o):len(t) - len(c)])
    return False


def _quote_split(text, keep_marks=True, pairs=None):
    """把「引号内 / 引号外」拆开，返回 [(片段, 是否引号内)]。

    符号表见 QUOTE_PAIRS，可被 options 里的 quote_pairs 覆盖。
    """
    pairs = pairs if pairs is not None else QUOTE_PAIRS
    close_of = {}
    for o, c in pairs:
        close_of.setdefault(o, c)
    out, buf, in_q = [], "", False
    closer = ""
    i, n = 0, len(text or "")
    while i < n:
        ch = text[i]
        if not in_q:
            close = close_of.get(ch)
            if close is None:
                buf += ch
            else:
                if ch not in STRONG_OPEN and close != ch:
                    # 弱符号：先看这一对里装的是什么，再决定要不要当台词
                    j = text.find(close, i + 1)
                    inner = text[i + 1:j] if j > i else ""
                    if j < 0 or not _inner_is_speech(inner, strict=ch in WEAK_OPEN):
                        buf += ch
                        i += 1
                        continue
                if buf.strip():
                    out.append((buf.strip(), False))
                buf, in_q, closer = ch, True, close
        else:
            buf += ch
            if ch == closer:
                out.append((buf.strip(), True))
                buf, in_q, closer = "", False, ""
        i += 1
    if buf.strip():
        out.append((buf.strip(), in_q))
    if not keep_marks:
        out = [((t.strip(ALL_MARKS) if q else t), q) for t, q in out]
    return [(t.strip(), q) for t, q in out if t.strip()]


def _paren_split(text):
    """按圆括号/方括号把内容拆出来，返回 [(片段, 是否括号内)]。"""
    out, buf, i, n = [], "", 0, len(text)
    opens = "（([［"
    closes = "）)]］"
    while i < n:
        ch = text[i]
        if ch in opens and not buf:
            buf = ch
            i += 1
            continue
        if ch in closes and buf and buf[0] in opens:
            buf += ch
            out.append((buf.strip(), True))
            buf = ""
            i += 1
            continue
        if ch in opens and buf:
            out.append((buf.strip(), False))
            buf = ch
            i += 1
            continue
        buf += ch
        i += 1
    if buf.strip():
        out.append((buf.strip(), False))
    return [(t, p) for t, p in out if t.strip()]


def _speaker_of(line):
    m = SPEAKER_RE.match(line)
    if not m:
        return None, line
    return (m.group(1).strip()[:20] or None), m.group(2).strip()


# ---------------------------------------------------------------- 各格式解析
def inspect_document(filename, data):
    name = (filename or "").lower()
    if name.endswith(".docx"):
        return _read_docx(data)
    text = _decode(data)
    if name.endswith(".srt") or _looks_srt(text):
        return _read_srt(text)
    if name.endswith(".csv") or name.endswith(".tsv"):
        return _read_csv(text, "\t" if name.endswith(".tsv") else ",")
    if name.endswith(".fountain") or _looks_fountain(text):
        return _read_fountain(text)
    return {"kind": "text", "text": text, "filename": filename, "meta": {}}


def _looks_srt(text):
    head = (text or "")[:4000]
    if not head:
        return False
    # 只要有「时间码 + 箭头/波浪线」就按字幕稿处理（箭头写法五花八门：--> → ⇒ ~ 至）
    return bool(re.search(r"(?:-{1,3}>|→|⇒|~|～|至|到)", head)
                and _TC_RE.search(_tc_fold(head)))


def _looks_fountain(text):
    head = text[:3000]
    if re.search(r"^\s*(?:Title|Author|Draft date|Contact)\s*:", head, re.M):
        return True
    return bool(re.search(r"^\s*(?:INT\.|EXT\.|INT/EXT|I/E)", head, re.M))


def _read_docx(data):
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            xml = z.read("word/document.xml")
        root = ET.fromstring(xml)
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"docx 解析失败：{e}")
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    blocks = []
    for p in root.iter(W + "p"):
        texts = [t.text or "" for t in p.iter(W + "t")]
        line = _norm_space("".join(texts))
        style = ""
        ppr = p.find("w:pPr", ns)
        if ppr is not None:
            st = ppr.find("w:pStyle", ns)
            if st is not None:
                style = (st.get(W + "val") or "").lower()
        blocks.append({"text": line, "style": style})
    text = "\n".join(b["text"] for b in blocks)
    return {"kind": "docx", "text": text, "blocks": blocks,
            "filename": "document.docx", "meta": {"paragraphs": len(blocks)}}


def _read_srt(text):
    """字幕稿：统一走 parse_timeline（箭头 / 全角冒号 / 与正文同行 / 缺序号 都能认）"""
    cues, stats = parse_timeline(text)
    if not cues:
        # 一个时间码都没认出来：别硬当成字幕稿，退回纯文本，免得后面「没有可用时间码」卡死
        return {"kind": "text", "text": text, "filename": "subtitle.srt", "meta": {}}
    body = "\n".join((c.get("text") or "").replace("\n", " ") for c in cues if c.get("text"))
    starts = [c["start"] for c in cues if c.get("start") is not None]
    return {"kind": "srt", "text": body, "raw": text, "cues": cues,
            "filename": "subtitle.srt",
            "meta": {"cues": len(cues), "tc_lines": stats.get("tc"),
                     "duration": round(max((c.get("end") or 0) for c in cues), 2) if cues else 0,
                     "start": round(min(starts), 2) if starts else 0}}


def _read_csv(text, delim=","):
    rows = list(csv.reader(io.StringIO(text), delimiter=delim))
    rows = [r for r in rows if any((c or "").strip() for c in r)]
    return {"kind": "csv", "text": text, "rows": rows,
            "header": rows[0] if rows else [],
            "filename": "table.csv",
            "meta": {"rows": max(0, len(rows) - 1), "cols": len(rows[0]) if rows else 0}}


FOUNTAIN_SCENE = re.compile(r"^(?:INT|EXT|EST|INT\.?/EXT|I/E)[.\s]", re.I)


def _read_fountain(text):
    """最小可用 fountain 解析：标题页 / 场景 / 角色 / 括号提示 / 对白 / 动作。"""
    raw = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = raw.split("\n")
    meta, i = {}, 0
    while i < len(lines):
        ln = lines[i].strip()
        if not ln:
            i += 1
            break
        m = re.match(r"^([A-Za-z][A-Za-z ]{1,20}):\s*(.*)$", ln)
        if not m:
            break
        meta[m.group(1).lower()] = m.group(2).strip()
        i += 1

    blocks = []
    scene, last_role, in_dialogue = None, None, False
    body_lines = [x.strip() for x in lines[i:]]
    for idx, s in enumerate(body_lines):
        if not s:
            in_dialogue = False
            continue
        if s.startswith("#"):
            blocks.append({"text": s.lstrip("# ").strip(), "kind": "chapter",
                           "chapter": s.lstrip("# ").strip()})
            in_dialogue = False
            continue
        if s.startswith("="):
            blocks.append({"text": s.lstrip("= ").strip(), "kind": "action",
                           "note": "大纲：" + s.lstrip("= ").strip(), "scene": scene})
            continue
        if s.startswith(">"):
            blocks.append({"text": s.lstrip("> ").strip(), "kind": "action",
                           "scene": scene, "note": "转场"})
            continue
        if FOUNTAIN_SCENE.match(s) or (s.isupper() and re.match(r"^(INT|EXT|内景|外景)", s)):
            scene = s
            blocks.append({"text": s, "kind": "scene", "scene": s})
            in_dialogue = False
            continue
        nxt = next((x for x in body_lines[idx + 1:] if x), "")
        is_cue = (not in_dialogue and 0 < len(s) <= 24
                  and not re.search(r"[。！？!?…，,；;]", s)
                  and not s.startswith(("(", "（", "「", "『"))
                  and bool(nxt) and nxt not in ("（", "(")
                  and not FOUNTAIN_SCENE.match(nxt))
        if is_cue:
            name = re.sub(r"\s*[（(].*?[）)]\s*", "", s).strip()
            last_role = name[:20] or None
            in_dialogue = True
            continue
        if s.startswith(("(", "（")) and in_dialogue:
            blocks.append({"text": s.strip("()（） "), "kind": "action", "role": last_role,
                           "scene": scene, "note": s.strip("()（） ")})
            continue
        if in_dialogue:
            blocks.append({"text": s, "kind": "dialogue", "role": last_role, "scene": scene})
        else:
            blocks.append({"text": s, "kind": "action", "scene": scene})
    return {"kind": "fountain", "text": text, "blocks": blocks,
            "filename": "script.fountain",
            "meta": {"title": meta.get("title"), "author": meta.get("author"),
                     "scenes": sum(1 for b in blocks if b["kind"] == "scene")}}


# ---------------------------------------------------------------- 特征检测
def _text_lines(src):
    kind = src.get("kind")
    if kind == "srt" and src.get("cues"):
        out = []
        for c in src["cues"]:
            out.extend([x.strip() for x in c["text"].split("\n") if x.strip()])
        return out
    if kind == "fountain" and src.get("blocks"):
        return [(b.get("text") or "").strip() for b in src["blocks"]
                if (b.get("text") or "").strip()
                and b.get("kind") in ("dialogue", "scene", "action")]
    if kind == "csv":
        return [(r[0] if r else "").strip() for r in (src.get("rows") or [])[1:]]
    return [l.strip() for l in (src.get("text") or "").split("\n") if l.strip()]


def _count_bare_cues(lines):
    """「短名字单独一行 + 下一行是台词」出现几次（剧本体的典型特征）。

    章节标题（第一章 / # 小标题）也短、也没标点，但它是标题不是角色名，要排除，
    否则小说会被误判成剧本。
    """
    cnt = 0
    for i, l in enumerate(lines):
        s = l.strip()
        if not (0 < len(s) <= 12) or PUNCT_RE.search(s):
            continue
        if s.startswith(("「", "『", "（", "(", "【", "[", "#")):
            continue
        if CHAPTER_RE.match(s) or SCENE_RE.match(s):
            continue
        nxt = ""
        for j in range(i + 1, len(lines)):
            if lines[j].strip():
                nxt = lines[j].strip()
                break
        if len(nxt) >= 4:
            cnt += 1
    return cnt


def detect(src, pairs=None):
    """判断这份文本属于 5 类里的哪一类，返回分数 + 证据。

    pairs：对白符号表（用户在选项里自定义时传进来），不传就用内置那套。
    """
    kind = src.get("kind") or "text"
    lines = _text_lines(src)
    n = max(1, len(lines))
    text = src.get("text") or ""

    # 时间码计数走同一套宽容解析（行首 / 行尾 / 独立成行 / 与正文同行都算）
    tc, tc_ranges = 0, 0
    if kind == "srt" and src.get("cues"):
        tc = sum(1 for c in src["cues"] if c.get("start") is not None)
        tc_ranges = sum(1 for c in src["cues"] if c.get("end") is not None)
    if not tc:
        try:
            _cs, _st = parse_timeline(src.get("raw") or text)
            tc, tc_ranges = _st.get("tc", 0), _st.get("ranges", 0)
        except Exception:  # noqa: BLE001
            tc, tc_ranges = 0, 0

    role_colon, roles = 0, set()
    for l in lines:
        m = SPEAKER_RE.match(l)
        if m and len(m.group(1).strip()) <= 12:
            role_colon += 1
            roles.add(m.group(1).strip())
    bare = _count_bare_cues(lines)
    scenes = sum(1 for l in lines if SCENE_RE.match(l))
    if kind == "fountain":
        scenes = max(scenes, sum(1 for b in (src.get("blocks") or []) if b.get("kind") == "scene"))

    quotes = sum(text.count(ch) for ch in ("「", "『", "“")) + text.count('"') // 2
    # 弱符号标的台词（`[李逍遥！你皮痒啊？]`、`【他走了。】`、《》…）：
    # 不认的话会被当成 `[镜头 3]` 那种标签，整篇判到「指令类」去。
    # 强符号（「」『』“”）上面已经数过了，这里只数弱符号的行。
    # 注意要传 pairs：用户自定义了符号（比如 `§台词§`）时，这里也得跟着认。
    weak_lines = 0
    for l in lines:
        t = l.strip()
        if t[:1] and t[:1] not in STRONG_OPEN and _line_quoted(t, pairs):
            weak_lines += 1
    if weak_lines:
        quotes += weak_lines

    tag_hits, tag_kw = 0, 0
    for m in TAG_ANY_RE.finditer(text):
        inner = m.group(1) or m.group(2) or ""
        if m.group(0)[:1] in WEAK_OPEN and _inner_is_speech(inner, strict=False):
            continue                     # 是台词，不是标签
        tag_hits += 1
        if TAG_KW_RE.search(inner):
            tag_kw += 1
    # 圆括号里的「（停顿 3 秒）」也算指令特征（冥想/引导稿常这么写）
    pause_marks = len(PAUSE_RE.findall(text))
    short_ratio = sum(1 for l in lines if len(l) <= 20) / n

    scores, ev = {}, {}

    # 1. 时间轴
    s, e = 0.0, []
    if kind == "srt" and tc:
        s = 1.0
        e.append(f"文件是 srt，共 {tc} 条字幕")
    elif tc:
        s = min(1.0, 0.55 + 0.05 * tc) if tc >= 2 else 0.34
        e.append(f"检测到 {tc} 处时间码（行首 / 行尾 / 独立成行 / 与正文同行都能认）")
        if tc_ranges:
            e.append(f"其中 {tc_ranges} 处带区间（起止时间）")
    scores["timeline"], ev["timeline"] = s, e

    # 2. 剧本
    s, e = 0.0, []
    if len(roles) >= 2 and role_colon >= 2:
        s = min(1.0, 0.62 + 0.06 * min(6, role_colon))
        e.append(f"检测到 {role_colon} 处「角色：台词」，共 {len(roles)} 个角色"
                 f"（{'、'.join(list(roles)[:4])}）")
    elif bare >= 2:
        s = min(0.92, 0.5 + 0.08 * min(5, bare))
        e.append(f"检测到 {bare} 处「短名字独占一行 + 紧跟台词」的剧本写法")
    if scenes:
        s = min(1.0, s + 0.12)
        e.append(f"检测到 {scenes} 个场景头（INT./EXT./第 x 场）")
    if kind == "fountain":
        s = max(s, 0.9)
        e.append("文件是 fountain 剧本格式")
    if tag_kw >= 2 or pause_marks >= 2:
        s *= 0.6          # 标签稿 / 引导稿里的短行不像角色名
    scores["script"], ev["script"] = s, e

    # 3. 小说
    s, e = 0.0, []
    if quotes >= 2:
        s = min(1.0, 0.5 + 0.06 * min(8, quotes))
        e.append(f"检测到 {quotes} 处成对引号（台词）")
    # 「整行就是一句台词」的行占比：纯对白稿没有旁白，也就没有任何角色线索，
    # 这种稿子只能按台词顺序交替分 A/B，先在这里把特征数出来
    quoted_lines = 0
    for l in lines:
        if _line_quoted(l.strip(), pairs):
            quoted_lines += 1
    q_ratio = quoted_lines / n
    if quoted_lines >= 4 and q_ratio >= 0.6:
        e.append(f"{int(q_ratio * 100)}% 的行整行就是一句台词（被「」[]【】《》之类包住）、"
                 f"几乎没有旁白（{quoted_lines} 行）→ 像没标角色的对白稿，"
                 f"导入时按顺序交替分「角色A / 角色B」")
    if weak_lines:
        e.append(f"其中 {weak_lines} 行用的是弱符号（[]【】《》{{}} 之类），按台词处理，不当标签")
    scores["novel"], ev["novel"] = s, e

    # 4. 指令
    s, e = 0.0, []
    if tag_kw >= 2:
        s = min(1.0, 0.55 + 0.07 * min(6, tag_kw))
        e.append(f"检测到 {tag_kw} 个指令标签（镜头/停顿/BGM/分格…）")
    elif tag_hits >= 2:
        s = min(0.7, 0.4 + 0.05 * min(6, tag_hits))
        e.append(f"检测到 {tag_hits} 处方括号标签")
    if pause_marks:
        s = max(s, min(0.86, 0.5 + 0.08 * min(5, pause_marks)))
        e.append(f"检测到 {pause_marks} 处停顿标记（（停顿 x 秒）之类）")
    if short_ratio > 0.72 and n >= 10:
        s = max(s, 0.68)
        e.append(f"{int(short_ratio * 100)}% 的行都很短（一行一句的强换行写法）")
    scores["tag"], ev["tag"] = s, e

    # 5. 纯文本（兜底）
    scores["plain"] = 0.35
    ev["plain"] = ["没有明显的时间码 / 角色前缀 / 引号对白 / 指令标签"]

    best = max(CLASS_ORDER, key=lambda c: (scores.get(c, 0), -CLASS_ORDER.index(c)))
    if scores.get(best, 0) < 0.45:
        best = "plain"

    ranked = sorted(((c, round(scores.get(c, 0), 2)) for c in CLASS_ORDER), key=lambda x: -x[1])
    return {
        "cls": best,
        "score": round(scores.get(best, 0), 2),
        "confidence": "high" if scores.get(best, 0) >= 0.8 else
                      ("mid" if scores.get(best, 0) >= 0.55 else "low"),
        "evidence": ev.get(best) or ["没有明显特征，按纯文本处理"],
        "ranked": [{"cls": c, "score": sc, "name": CLASS_MAP[c]["name"],
                    "icon": CLASS_MAP[c]["icon"]} for c, sc in ranked],
        "stats": {"lines": len(lines), "timecodes": tc, "tc_ranges": tc_ranges,
                  "roles": len(roles),
                  "role_lines": role_colon, "bare_cues": bare, "scenes": scenes,
                  "quotes": quotes, "tags": tag_hits, "tag_kw": tag_kw,
                  "quoted_lines": quoted_lines, "quoted_ratio": round(q_ratio, 2),
                  "weak_quote_lines": weak_lines,
                  "short_ratio": round(short_ratio, 2), "kind": kind},
    }


# ---------------------------------------------------------------- 时间轴类
def _cues_from_text(text, opts=None):
    """纯文本里的时间码 → cue 列表（旧入口，统一转发到 parse_timeline）"""
    cues, _stats = parse_timeline(text, opts)
    return cues


def _plan_timeline(src, o):
    max_chars = o["max_chars"]
    group_by = o["group_by"]
    issues = []

    custom = bool(o.get("tc_custom"))
    tc_stats = {}
    cues = None
    # 用户自定义了时间码格式 → 一定按自定义重新解析原始文本（srt 的 cue 是内置规则切的）
    if not custom:
        raw_cues = src.get("cues")
        if src.get("kind") == "srt" and raw_cues:
            cues = [dict(c) for c in raw_cues]
    if not cues:
        src_text = src.get("raw") or src.get("text") or ""
        cues, tc_stats = parse_timeline(src_text, o)
    if not cues:
        issues.append({"level": "error",
                       "msg": "没有找到可用时间码。如果时间码写法比较特别，"
                              "可以在下面「自定义时间码格式」里贴一个例子再试"})
        return [], issues, {"cues": 0}

    gap_mode = o.get("gap_mode") or "smart"
    gap_min = _num(o.get("gap_min"), 120, 0, 5000)
    gap_max = _num(o.get("gap_max"), 3000, 200, 60000)
    gap_scale = _num(o.get("gap_scale"), 1.0, 0.2, 2.0)
    fixed_ms = _clamp_ms(o.get("fixed_ms"), 0, 10000)
    part_sec = _num(o.get("part_seconds"), 60, 10, 600)
    use_t0 = bool(o.get("use_t0", True))
    bi = bool(o.get("bilingual_split", True))
    lang_keep = o.get("lang_keep") or "both"
    merge_short = bool(o.get("merge_short"))

    # 极短字幕并到上一条（保留上一条的 start、这一条的 end）
    if merge_short:
        merged = []
        for c in cues:
            if merged and len((c.get("text") or "").strip()) <= 4:
                prev = merged[-1]
                prev["text"] = _norm_space((prev.get("text") or "") + (c.get("text") or ""))
                prev["end"] = c.get("end") or prev.get("end")
                continue
            merged.append(dict(c))
        cues = merged

    groups, order, seq = {}, [], 0
    total, long_gaps = 0, 0

    def push(gname, seg):
        if gname not in groups:
            groups[gname] = []
            order.append(gname)
        groups[gname].append(seg)

    for ci, cu in enumerate(cues):
        raw = (cu.get("text") or "").strip()
        if not raw:
            continue
        lines = [x.strip() for x in raw.split("\n") if x.strip()]
        pieces = []
        if bi and len(lines) >= 2 and _is_cjk(lines[0]) != _is_cjk(lines[1]):
            for ln in lines:
                lang = "cjk" if _is_cjk(ln) else "latin"
                if lang_keep != "both" and lang_keep != lang:
                    continue
                pieces.append((ln, lang))
        else:
            pieces.append((" ".join(lines) if lines else raw, "cjk" if _is_cjk(raw) else "latin"))
        if not pieces:
            continue

        role = None
        if len(pieces) == 1:
            sp, rest = _speaker_of(pieces[0][0].lstrip("-— ").strip())
            if sp:
                role, pieces = sp, [(rest, pieces[0][1])]

        nxt = cues[ci + 1] if ci + 1 < len(cues) else None
        pause = None
        if gap_mode != "none":
            if gap_mode == "fixed":
                pause = fixed_ms
            else:
                end = cu.get("end")
                nstart = nxt.get("start") if nxt else None
                if end is not None and nstart is not None:
                    gap = (float(nstart) - float(end)) * 1000.0
                    if gap <= gap_min:
                        pause = 0
                    else:
                        if gap > gap_max:
                            long_gaps += 1
                        pause = int(round(min(gap_max, gap * gap_scale) / 10.0) * 10)
                else:
                    pause = 0

        for pi, (txt, lang) in enumerate(pieces):
            txt = _norm_space(txt)
            if not txt:
                continue
            segs = split_smart(txt, max_chars)
            for k, sg in enumerate(segs):
                seq += 1
                t0 = cu.get("start")
                if group_by == "speaker":
                    gname = role or "未标注说话人"
                elif group_by == "lang":
                    gname = "中文" if lang == "cjk" else "外文"
                elif group_by == "part" and t0 is not None:
                    band = int(float(t0) // part_sec)
                    gname = f"第 {band + 1} 段（{_fmt_tc(band * part_sec)} 起）"
                else:
                    gname = "正文"
                seg = {
                    "i": seq, "text": sg["text"],
                    "note": f"角色：{role}" if role else "",
                    "role": role or "", "quoted": False,
                    # 一条字幕拆成几条（多段 / 中英两行）时，空档只挂在最后一条上，
                    # 否则每条都带一次停顿，整体会被拖慢一倍
                    "pause": (pause if (k == len(segs) - 1 and pi == len(pieces) - 1) else 0),
                    "slow": False, "over": bool(sg["over"]), "group": gname,
                }
                if use_t0 and t0 is not None:
                    seg["t0"] = round(float(t0), 3)
                    seg["t1"] = round(float(cu.get("end") or t0), 3)
                if lang == "latin":
                    seg["note"] = (seg["note"] + "；" if seg["note"] else "") + "外文"
                push(gname, seg)
                total += len(sg["text"])
                if seg["over"]:
                    issues.append({"level": "warn", "group": gname,
                                   "msg": f"有一条字幕 {len(sg['text'])} 字超过上限 {max_chars}"
                                          f"（引号/括号内不宜切分），已保留原文请人工拆分",
                                   "text": sg["text"][:40]})

    out = _finish(groups, order)
    if long_gaps:
        issues.append({"level": "warn",
                       "msg": f"有 {long_gaps} 处空档超过 {int(gap_max)}ms，已按上限截断"
                              f"（想保留更长的静默可以调高「空档截断」）"})
    no_tc = sum(1 for c in cues if c.get("start") is None)
    if no_tc and len(cues) > 3:
        issues.append({"level": "warn",
                       "msg": f"有 {no_tc} 段没认出时间码（多半是片头说明或时间码写法特殊），"
                              f"这些段按顺序排；识别不全可以调高「时间码位置」或自定义格式"})
    stats = {"cues": len(cues), "long_gaps": long_gaps, "mode": gap_mode,
             "no_tc": no_tc, "tc_custom": bool(custom)}
    stats.update({k: v for k, v in (tc_stats or {}).items() if k in ("tc", "ranges", "fps")})
    return out, issues, stats


# ---------------------------------------------------------------- 剧本类
def _script_blocks(text, styled=None, role_style="auto"):
    """把剧本正文整理成 block：chapter / scene / cue / action / para。"""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    norm = [_norm_space(x) for x in lines]
    colon = 0
    for s in norm:
        m = SPEAKER_RE.match(s) if s else None
        if m and len(m.group(1)) <= 12:
            colon += 1
    bare = _count_bare_cues([s for s in norm if s])
    style = role_style
    if style == "auto":
        style = "colon" if colon > bare else ("line" if bare else "colon")

    blocks, chapter = [], None
    for idx, s in enumerate(norm):
        if not s:
            continue
        style_name = (styled[idx].get("style") if styled and idx < len(styled) else "") or ""
        if "heading" in style_name or style_name.startswith("标题") or s.startswith("#"):
            chapter = s.lstrip("# ").strip()
            blocks.append({"text": chapter, "kind": "chapter", "chapter": chapter})
            continue
        if CHAPTER_RE.match(s) and len(s) <= 40:
            chapter = s.lstrip("# ").strip()
            blocks.append({"text": chapter, "kind": "chapter", "chapter": chapter})
            continue
        if SCENE_RE.match(s) or FOUNTAIN_SCENE.match(s):
            blocks.append({"text": s, "kind": "scene", "scene": s, "chapter": chapter})
            continue
        if s.startswith(("（", "(")) and s.endswith(("）", ")")):
            blocks.append({"text": s.strip("（）() "), "kind": "action", "chapter": chapter})
            continue
        if style == "line":
            nxt = ""
            for j in range(idx + 1, len(norm)):
                if norm[j]:
                    nxt = norm[j]
                    break
            if (0 < len(s) <= 24 and not PUNCT_RE.search(s)
                    and not s.startswith(("「", "『", "（", "(", "【"))
                    and len(nxt) >= 4):
                blocks.append({"text": s, "kind": "cue", "role": s[:20], "chapter": chapter})
                continue
        blocks.append({"text": s, "kind": "para", "chapter": chapter})
    return blocks


def _script_group(group_by, role, scene, chapter):
    if group_by == "role":
        return role or "旁白"
    if group_by == "scene":
        return scene or "未分场"
    if group_by == "scene_role":
        return f"{(scene or '未分场')} · {(role or '旁白')}"
    if group_by == "chapter":
        return chapter or "正文"
    return "正文"


def _plan_script(src, o):
    max_chars = o["max_chars"]
    group_by = o["group_by"]
    issues = []
    role_style = (o.get("role_style") or "auto").lower()
    role_note = bool(o.get("role_note"))
    scene_note = bool(o.get("scene_note", True))
    action_note = bool(o.get("action_note", True))
    paren_name = bool(o.get("paren_name", True))
    merge_same = bool(o.get("merge_same_role", True))

    kind = src.get("kind")
    if kind == "fountain" and src.get("blocks"):
        blocks = [dict(b) for b in src["blocks"]]
    else:
        blocks = _script_blocks(src.get("text") or "",
                                src.get("blocks") if kind == "docx" else None, role_style)

    groups, order, seq = {}, [], 0
    state = {"scene": None, "chapter": None}
    pending = []
    buf = None

    def push(seg):
        g = seg["group"]
        if g not in groups:
            groups[g] = []
            order.append(g)
        groups[g].append(seg)

    def flush():
        nonlocal buf
        if buf and (buf.get("text") or "").strip():
            push(buf)
        buf = None

    def emit(text, role, bits):
        nonlocal buf, seq
        text = _norm_space(text)
        if not text:
            return
        gname = _script_group(group_by, role, state["scene"], state["chapter"])
        segs = split_smart(text, max_chars, no_merge=not merge_same)
        for sg in segs:
            if merge_same and buf and buf["role"] == (role or "") and buf["group"] == gname \
                    and len(buf["text"]) + len(sg["text"]) <= max_chars:
                buf["text"] += sg["text"]
                continue
            flush()
            seq += 1
            seg = {
                "i": seq, "text": sg["text"],
                "note": "；".join([x for x in bits if x])[:200],
                "role": role or "", "quoted": False, "pause": None, "slow": False,
                "over": bool(sg["over"]), "group": gname,
            }
            if merge_same:
                buf = seg
            else:
                push(seg)
            if sg["over"]:
                issues.append({"level": "warn", "group": gname,
                               "msg": f"「{gname}」有一段 {len(sg['text'])} 字超过上限 {max_chars}"
                                      f"（引号/括号内不宜切分），已保留原文", "text": sg["text"][:40]})

    for b in blocks:
        bkind = b.get("kind") or "para"
        raw = _norm_space(b.get("text") or "")
        if bkind == "chapter":
            flush()
            state["chapter"] = raw
            continue
        if bkind == "scene":
            flush()
            state["scene"] = raw
            if scene_note:
                pending.append(f"场景：{raw}")
            continue
        if bkind == "action":
            if action_note and raw:
                pending.append(raw)
            continue
        if not raw:
            continue
        role = (b.get("role") or "").strip() or None
        if bkind != "cue":
            sp, rest = _speaker_of(raw)
            if sp:
                role, raw = sp, rest
        if paren_name and role and raw.startswith(("（", "(")):
            m = re.match(r"^[（(]([^）)]{0,40})[）)]\s*(.*)$", raw)
            if m:
                if action_note and m.group(1):
                    pending.append(_norm_space(m.group(1)))
                raw = m.group(2)
        bits = list(pending)
        pending = []
        if b.get("note") and str(b["note"]) not in bits:
            bits.append(str(b["note"]))
        body, acts = _extract_actions(raw)
        if action_note:
            bits += [x for x in acts if x not in bits]
        if role_note and role:
            bits.insert(0, f"角色：{role}")
        emit(body, role, bits)
    flush()

    out = _finish(groups, order)
    return out, issues, {"blocks": len(blocks), "role_style": role_style}


# ---------------------------------------------------------------- 小说类
def _novel_paragraphs(text, chapter_mode="auto"):
    """[(章节名, 段落正文)]

    注意：这里**逐行**产出（不是把整段揉成一行）。揉成一行会让
    「“路上堵车。”张三把外套挂在椅背上。」的旁白跑到下一句台词前面去，
    高级识别的「后置旁白」就会张冠李戴 —— 相邻关系必须保住。
    跨行的长句仍会在 split_smart 里按句号合并，不会碎成一条一条。
    """
    raw = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    blocks = re.split(r"\n\s*\n", raw)
    if chapter_mode == "blank":
        out = []
        for b in blocks:
            for ln in b.split("\n"):
                ln = _norm_space(ln)
                if ln:
                    out.append((None, ln))
        return out

    out, chapter = [], None
    buf = []

    def flush():
        for block_text in buf:
            for ln in block_text.split("\n"):
                ln = _norm_space(ln)
                if ln:
                    out.append((chapter, ln))
        buf.clear()

    for b in blocks:
        s = _norm_space(b)
        if not s:
            continue
        is_head = False
        if chapter_mode in ("auto", "hash"):
            if s.startswith("#"):
                is_head = True
            elif chapter_mode == "auto" and CHAPTER_RE.match(s) and len(s) <= 40:
                is_head = True
        if is_head:
            flush()
            chapter = s.lstrip("# ").strip()
            continue
        buf.append(s)
    flush()
    return out


SPEAKER_A = "角色A"
SPEAKER_B = "角色B"
SPEAKER_GROUP_RE = re.compile(r"^角色[AB]$")     # 前端用同一条规则决定要不要显示角色下拉


def _novel_group(group_by, chapter, kind, role=""):
    """分组名。role 只在「按角色」口径下参与命名，其它口径仍回落 旁白 / 台词。"""
    role = (role or "").strip()
    if kind == "dialogue" and role and group_by in ("speaker", "chapter_speaker"):
        k = role
    else:
        k = "台词" if kind == "dialogue" else "旁白"
    if group_by == "chapter":
        return chapter or "正文"
    if group_by in ("kind", "role", "speaker"):
        return k
    if group_by in ("chapter_kind", "chapter_speaker"):
        return f"{chapter or '正文'} · {k}"
    return "正文"


def _plan_novel(src, o):
    max_chars = o["max_chars"]
    group_by = o["group_by"]
    issues = []
    quote_split = bool(o.get("quote_split", True))
    paren_split = bool(o.get("paren_split", True))
    paren_note = bool(o.get("paren_note"))
    keep_marks = bool(o.get("keep_marks", True))
    chapter_mode = (o.get("chapter_mode") or "auto").lower()

    text = src.get("text") or ""
    if src.get("kind") == "docx" and src.get("blocks"):
        text = "\n".join(b.get("text") or "" for b in src["blocks"])
    paras = _novel_paragraphs(text, chapter_mode)

    # ① 先只收集片段、不落段：得先看清「整份稿子几乎全是引号台词、而且没有章节」，
    #    才知道要不要按角色交替。纯对白稿的每一行都长得一样，光看单行分不出是谁说的。
    pieces_all = []          # (章节, 正文, kind, notes)
    qpairs = _quote_pairs(o.get("quote_pairs"))
    for chapter, para in paras:
        pieces = []          # (正文, kind, notes)
        if quote_split:
            for piece, quoted in _quote_split(para, keep_marks, qpairs):
                if quoted:
                    pieces.append((piece, "dialogue", []))
                    continue
                if paren_split and not paren_note:
                    for sub, is_par in _paren_split(piece):
                        if is_par:
                            pieces.append((sub.strip("（）()［］[] "), "paren", []))
                        else:
                            pieces.append((sub, "narration", []))
                else:
                    acts = []
                    body = piece
                    if paren_note:
                        body, acts = _extract_actions(piece)
                    pieces.append((body, "narration", acts))
        else:
            body, acts = para, []
            if paren_note:
                body, acts = _extract_actions(para)
            pieces.append((body, "narration", acts))

        for body, kind, notes in pieces:
            body = _norm_space(body)
            if body:
                pieces_all.append((chapter, body, kind, notes))

    # ② 要不要分角色：台词段 ≥4、台词占 ≥72%、且没有章节头
    n_dia = sum(1 for p in pieces_all if p[2] == "dialogue")
    dia_ratio = n_dia / max(1, len(pieces_all))
    has_chapter = any(p[0] for p in pieces_all)
    mode = (o.get("speaker_mode") or "auto").lower()
    if mode not in ("auto", "alt2", "adv", "off"):
        mode = "auto"
    auto_alt = bool(n_dia >= 4 and dia_ratio >= 0.72)
    adv = mode == "adv"
    alt = mode in ("alt2", "adv") or (mode == "auto" and auto_alt)
    if mode == "off":
        alt = False
    elif group_by in ("speaker", "chapter_speaker"):
        alt = True                    # 明确选了「按角色」，就别等自动判断
    switched = False
    explicit_group = bool(o.get("_group_by_explicit"))
    if alt and not explicit_group and group_by == "chapter":
        # 默认口径是「按章节」，可这份稿子几乎全是台词：塞进章节组里就是一个章节一个音色，
        # 等于没分角色。改成按角色两组（章节信息仍留在每段的播放顺序里）
        group_by = "speaker"
        switched = True

    # ③ 每一段到底算谁说的
    #    alt2 = 按顺序交替 A/B（只认得"两个人在说话"）
    #    adv  = 先看旁白里的名字线索（张三说 / 「…」李四说 / 李四：「…」），
    #           认得出就用真名，认不出再退回交替 —— 这就是「高级智能识别」
    adv_att = None
    if adv and n_dia:
        try:
            import lf_roles as ROLE          # 单独一层，不启用时完全不参与
            adv_att = ROLE.attribute([
                {"kind": p[2], "text": p[1]} for p in pieces_all
            ])
        except Exception:                    # noqa: BLE001  引擎坏了不能拖垮导入
            adv_att = None
            adv = False
    piece_roles = []                         # [(role, source, conf)]
    spk_i = 0
    named = guessed = 0
    name_hits = {}
    for idx, p in enumerate(pieces_all):
        kind = p[2]
        role, src, conf = "", "", 0.0
        if alt and kind == "dialogue":
            a = adv_att[idx] if adv_att else None
            if a and a.get("role"):
                role, src, conf = a["role"], a.get("source") or "rule", float(a.get("conf") or 0.8)
                named += 1
                name_hits[role] = name_hits.get(role, 0) + 1
            else:
                role = SPEAKER_A if spk_i % 2 == 0 else SPEAKER_B
                spk_i += 1
                src, conf = "alternate", 0.3
                guessed += 1
        piece_roles.append((role, src, conf))

    groups, order, seq = {}, [], 0
    total = 0
    spk_a = sum(1 for r in piece_roles if r[0] == SPEAKER_A)
    spk_b = sum(1 for r in piece_roles if r[0] == SPEAKER_B)

    def push(gname, seg):
        if gname not in groups:
            groups[gname] = []
            order.append(gname)
        groups[gname].append(seg)

    for idx, (chapter, body, kind, notes) in enumerate(pieces_all):
        role, role_src, role_conf = piece_roles[idx]
        gname = _novel_group(group_by, chapter, kind, role)
        segs = split_smart(body, max_chars)
        for si, sg in enumerate(segs):
            seq += 1
            bits = list(notes) if si == 0 else []
            if kind == "dialogue" and si == 0:
                bits.insert(0, "台词")
            elif kind == "paren" and si == 0:
                bits.insert(0, "括号")
            seg = {
                "i": seq, "text": sg["text"],
                "note": "；".join([x for x in bits if x])[:200],
                "role": role, "role_src": role_src, "role_conf": round(role_conf, 2),
                "quoted": kind == "dialogue", "pause": None,
                "slow": False, "over": bool(sg["over"]), "group": gname,
            }
            push(gname, seg)
            total += len(sg["text"])
            if sg["over"]:
                issues.append({"level": "warn", "group": gname,
                               "msg": f"「{gname}」有一段 {len(sg['text'])} 字超过上限 {max_chars}"
                                      f"（引号/括号内不宜切分），已保留原文",
                               "text": sg["text"][:40]})
    if adv and named:
        top = "、".join(sorted(name_hits, key=lambda k: -name_hits[k])[:4])
        issues.append({"level": "info", "group": "",
                       "msg": f"高级识别：认出 {len(name_hits)} 个角色（{top}），"
                              f"{named} 段按名字归属；剩下 {guessed} 段没线索，仍按顺序交替"
                              f"（{SPEAKER_A} / {SPEAKER_B}）"})
    elif alt and mode == "auto" and spk_a + spk_b >= 4:
        issues.append({"level": "info", "group": "",
                       "msg": f"没有角色标注，按台词顺序交替分成「{SPEAKER_A} / {SPEAKER_B}」"
                              f"（{spk_a} 段 / {spk_b} 段）；猜错了可以改组名或逐句改归属"})
    out = _finish(groups, order)
    return out, issues, {
        "paragraphs": len(paras), "chars": total,
        "group_by": group_by,
        "speaker": {
            "mode": "adv" if adv else ("alt2" if alt else "off"),
            "auto": bool(mode == "auto" and auto_alt),
            "a": spk_a, "b": spk_b,
            "named": named, "guessed": guessed,
            "names": sorted(name_hits, key=lambda k: -name_hits[k])[:12],
            "dialogue": n_dia, "ratio": round(dia_ratio, 2),
            "switched_group": switched,
        },
    }


# ---------------------------------------------------------------- 指令类
def _plan_tag(src, o):
    max_chars = o["max_chars"]
    group_by = o["group_by"]
    issues = []
    tag_mode = (o.get("tag_mode") or "note").lower()
    pause_tags = bool(o.get("pause_tags", True))
    pause_cap = _clamp_ms(o.get("pause_cap"), 1000, 60000)
    paren_note = bool(o.get("paren_note", True))
    line_strict = bool(o.get("line_strict", True))
    merge_short = bool(o.get("merge_short_lines"))

    text = (src.get("text") or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = [l.strip() for l in text.split("\n")]
    # 碎行（≤4 字、不是标签）并到下一行：一行一段时难免有「好。」这种独立成行的碎句
    if merge_short:
        merged = []
        carry = ""
        for ln in lines:
            if not ln:
                continue
            if TAG_ANY_RE.search(ln) or PAUSE_RE.search(ln):
                if carry:
                    merged.append(carry)
                    carry = ""
                merged.append(ln)
                continue
            if len(ln) <= 4:
                carry = (carry + ln) if carry else ln
                continue
            merged.append((carry + ln) if carry else ln)
            carry = ""
        if carry:
            merged.append(carry)
        lines = merged
    # 不要求「一行一段」时：连续的正文行先并成段落，再按上限切
    # （不合并的话每行都会单独成段，max_chars 就白设了）
    if not line_strict:
        merged, par = [], []
        for ln in lines:
            if not ln:
                if par:
                    merged.append("".join(par))
                    par = []
                continue
            if TAG_ANY_RE.search(ln) or PAUSE_RE.search(ln) or CHAPTER_RE.match(ln):
                if par:
                    merged.append("".join(par))
                    par = []
                merged.append(ln)
                continue
            par.append(ln if _is_cjk(ln) else " " + ln)
        if par:
            merged.append("".join(par))
        lines = merged
    groups, order, seq = {}, [], 0
    cur_tag, chapter = None, None
    pending = []
    last_seg = None

    def push(gname, seg):
        if gname not in groups:
            groups[gname] = []
            order.append(gname)
        groups[gname].append(seg)

    for raw in lines:
        if not raw:
            continue
        line = raw
        pause_ms = None
        if pause_tags:
            line, pause_ms = _clean_pause_marks(line, pause_cap)
            if pause_ms is not None and not line.strip():
                if last_seg is not None:
                    last_seg["pause"] = max(int(last_seg.get("pause") or 0), pause_ms)
                continue

        tag_names = []

        def _sub(m):
            inner = _norm_space(m.group(1) or m.group(2) or "")
            if inner:
                tag_names.append(inner)
            return ""

        no_tags = TAG_ANY_RE.sub(_sub, line)

        if group_by == "chapter" and CHAPTER_RE.match(_norm_space(no_tags)) \
                and len(_norm_space(no_tags)) <= 40:
            chapter = _norm_space(no_tags).lstrip("# ").strip()
            continue

        group_tag = next((t for t in tag_names if TAG_GROUP_RE.search(t)), None)
        # 只要「按标签分组」或者「标签当分组名」，标签就要真的变成分组
        use_tag_group = (group_by == "tag") or (tag_mode == "group")

        if tag_mode == "keep":
            body = _norm_space(line)
            acts = []
            if paren_note:
                body, acts = _extract_actions(body, paren_only=True)
        else:
            body = _norm_space(no_tags)
            acts = []
            if paren_note:
                body, acts = _extract_actions(body)

        notes = []
        if tag_mode == "note":
            notes += tag_names
        notes += acts
        notes += pending
        pending = []

        if not body:
            if tag_mode == "note" and tag_names:
                pending = tag_names
            if use_tag_group and group_tag:
                cur_tag = group_tag
            continue

        if use_tag_group and group_tag:
            cur_tag = group_tag

        if use_tag_group:
            gname = cur_tag or "正文"
        elif group_by == "chapter":
            gname = chapter or "正文"
        else:
            gname = "正文"

        if line_strict:
            segs = [{"text": body, "over": len(body) > max_chars}]
        else:
            segs = split_smart(body, max_chars)

        for k, sg in enumerate(segs):
            seq += 1
            seg = {
                "i": seq, "text": sg["text"],
                "note": "；".join([x for x in notes if x])[:200],
                "role": "", "quoted": False,
                "pause": (pause_ms if k == len(segs) - 1 else None),
                "slow": False, "over": bool(sg["over"]), "group": gname,
            }
            push(gname, seg)
            last_seg = seg
            if sg["over"]:
                issues.append({"level": "warn", "group": gname,
                               "msg": f"「{gname}」有一行 {len(sg['text'])} 字超过上限 {max_chars}，"
                                      f"已保留原文请人工拆分", "text": sg["text"][:40]})

    if pending and last_seg is not None:
        last_seg["note"] = "；".join([x for x in [last_seg.get("note"), *pending] if x])[:200]
    out = _finish(groups, order)
    return out, issues, {"lines": len(lines),
                         "tags": sum(1 for l in lines if TAG_ANY_RE.search(l))}


# ---------------------------------------------------------------- 纯文本
def _plan_plain(src, o):
    max_chars = o["max_chars"]
    group_by = o["group_by"]
    issues = []
    seg_mode = (o.get("seg_mode") or "length").lower()
    group_n = int(_num(o.get("group_n"), 20, 2, 200))
    chapter_mode = (o.get("chapter_mode") or "auto").lower()
    para_pause = _clamp_ms(o.get("pause_per_para"), 0, 5000) or None

    text = src.get("text") or ""
    if src.get("kind") == "csv" and src.get("rows"):
        text = "\n".join((r[0] or "") for r in src["rows"][1:] if r)
    elif src.get("kind") == "docx" and src.get("blocks"):
        text = "\n".join(b.get("text") or "" for b in src["blocks"])
    elif src.get("kind") == "srt" and src.get("cues"):
        text = "\n".join(c["text"] for c in src["cues"])

    paras = []
    if seg_mode == "paragraph":
        paras = _novel_paragraphs(text, chapter_mode)
    else:
        chapter, buf = None, []
        for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
            s = _norm_space(line)
            if not s:
                continue
            is_head = chapter_mode != "off" and (
                (s.startswith("#") and chapter_mode in ("auto", "hash"))
                or (chapter_mode == "auto" and CHAPTER_RE.match(s) and len(s) <= 40))
            if is_head:
                if buf:
                    paras.append((chapter, " ".join(buf)))
                    buf = []
                chapter = s.lstrip("# ").strip()
                continue
            buf.append(s)
        if buf:
            paras.append((chapter, " ".join(buf)))

    groups, order, seq, total = {}, [], 0, 0

    def push(gname, seg):
        if gname not in groups:
            groups[gname] = []
            order.append(gname)
        groups[gname].append(seg)

    for chapter, body in paras:
        if not body.strip():
            continue
        if seg_mode == "paragraph":
            pieces = split_smart(body, max_chars) if len(body) > max_chars \
                else [{"text": body, "over": False}]
        elif seg_mode == "sentence":
            pieces = split_smart(body, max_chars, no_merge=True)
        else:
            pieces = split_smart(body, max_chars)
        for sg in pieces:
            seq += 1
            if group_by == "chapter":
                gname = chapter or "正文"
            elif group_by == "every_n":
                gname = f"第 {total // group_n + 1} 组"
            else:
                gname = "正文"
            seg = {
                "i": seq, "text": sg["text"], "note": "", "role": "", "quoted": False,
                "pause": para_pause if seg_mode == "paragraph" else None,
                "slow": False, "over": bool(sg["over"]), "group": gname,
            }
            push(gname, seg)
            total += 1
            if sg["over"]:
                issues.append({"level": "warn", "group": gname,
                               "msg": f"「{gname}」有一段 {len(sg['text'])} 字超过上限 {max_chars}"
                                      f"（引号/括号内不宜切分），已保留原文", "text": sg["text"][:40]})
    out = _finish(groups, order)
    return out, issues, {"paragraphs": len(paras)}


# ---------------------------------------------------------------- 公共收尾 / 入口
def _finish(groups, order):
    out = []
    for gname in order:
        segs = groups.get(gname) or []
        if not segs:
            continue
        segs.sort(key=lambda s: s.get("i") or 0)
        out.append({"name": gname, "note": "", "params": {}, "segments": segs,
                    "chars": sum(len(s["text"]) for s in segs)})
    return out


PLANNERS = {
    "timeline": _plan_timeline,
    "script": _plan_script,
    "novel": _plan_novel,
    "tag": _plan_tag,
    "plain": _plan_plain,
}


def class_info(cid):
    c = CLASS_MAP.get(cid)
    if not c:
        return None
    return {k: c.get(k) for k in ("id", "name", "icon", "desc", "detail", "sample", "hints",
                                  "opts", "group_opts", "default_group", "default_max",
                                  "presets")}


def defaults_of(cid):
    c = CLASS_MAP.get(cid) or CLASS_MAP["plain"]
    d = {o["k"]: o["def"] for o in c.get("opts") or []}
    d["group_by"] = c.get("default_group") or "none"
    d["max_chars"] = c.get("default_max") or DEFAULT_SEG_CHARS
    return d


def plan(src, cls=None, opts=None):
    """src + 类别 + 选项 → groups / issues / stats。cls 为空时自动检测。"""
    opts = dict(opts or {})
    det = detect(src, _quote_pairs(opts.get("quote_pairs")))
    cid = cls if cls in CLASS_MAP else det["cls"]
    cfg = defaults_of(cid)
    cfg.update({k: v for k, v in opts.items() if v is not None})
    cfg["max_chars"] = int(max(12, min(MAX_SEG_CHARS, int(_num(
        cfg.get("max_chars"), CLASS_MAP[cid]["default_max"])))))
    allowed = [g for g, _ in (CLASS_MAP[cid].get("group_opts") or [])]
    if cfg.get("group_by") not in allowed:
        cfg["group_by"] = CLASS_MAP[cid].get("default_group") or "none"
    # 调用方有没有自己选过分组口径：有就绝不替用户改（只有「没选」才允许按内容自适应）
    cfg["_group_by_explicit"] = "group_by" in opts

    groups, issues, extra = PLANNERS[cid](src, cfg)
    cfg.pop("_group_by_explicit", None)
    if extra.get("group_by") in allowed:
        cfg["group_by"] = extra["group_by"]      # planner 可能改口（纯对白稿 → 按角色）
    stats = {
        "cls": cid, "cls_name": CLASS_MAP[cid]["name"], "group_by": cfg["group_by"],
        "max_chars": cfg["max_chars"],
        "groups": len(groups),
        "segments": sum(len(g["segments"]) for g in groups),
        "chars": sum(g["chars"] for g in groups),
        "warns": sum(1 for i in issues if i["level"] == "warn"),
        "kind": src.get("kind"),
    }
    stats.update({k: v for k, v in extra.items() if k not in stats})
    return {
        "cls": cid,
        "cls_info": {"id": cid, "name": CLASS_MAP[cid]["name"], "icon": CLASS_MAP[cid]["icon"],
                     "detail": CLASS_MAP[cid].get("detail"), "hints": CLASS_MAP[cid].get("hints")},
        "detect": det,
        "auto": cls is None,
        "groups": groups,
        "issues": issues[:200],
        "stats": stats,
        "opts": cfg,
    }
