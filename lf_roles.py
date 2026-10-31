# -*- coding: utf-8 -*-
"""lf_roles.py —— 「这句话是谁说的」：规则归属引擎（可选，默认不启用）

为什么单独一层：
    智能导入原本只有两种口径 —— 有「名字：」前缀就按角色切（剧本类），
    没有就按台词顺序交替 A/B（小说类 / 纯对白稿）。
    前者要求稿子写了名字，后者只能猜两个人在轮着说。
    真正常见的是第三种：名字写在**旁白**里（「你怎么才来？」李四说。），
    既没有前缀，也不是严格交替 —— 这时候两条路都不对。

这一层的活儿只有一个：给每一段标一个 role（谁说的）+ source（依据）+ conf（把握）。
分组、音色、切分都不管，那些仍然由 lf_import 决定。

三条设计原则（吃过亏的）：
  1. **优先级链，不是投票**。投票会让旁白里的名字污染结果：
     「张三把刀放在桌上。屋里安静下来。」这句台词其实不是张三说的。
  2. **名字出现 ≠ 名字说话**。名字前有「对/向/对着」、后有「听到/传来」、
     中间夹「没有/没/未」，都不是说话人。
  3. **宁可认不出，也不要造幽灵角色**。认不出就返回空，交给交替兜底；
     姓氏表 + 窗口硬切会切出「边小声」（旁边小声说）这种根本不存在的角色。

对外只有两个函数：find_names() / attribute()。
"""
from __future__ import annotations

import re

# ---------------------------------------------------------------- 词表
# 说话动词（后面可以跟「：」或直接接内容）
_VERBS = (
    "说道|问道|答道|回道|应道|笑道|冷笑道|怒道|沉声道|低声道|开口道|接着说|继续说|"
    "说|道|问|答|喊|叫|嚷|吼|骂道|叹道|嘟囔|喃喃|自语|嘀咕|补充|解释|"
    "冷笑|苦笑|开口|插话|接话|回应|回答|反问|追问|嘱咐|念叨|出声"
)
# 名字和动词之间允许夹的修饰（不超过 6 字，且不能是否定/对象词）
_GAP_NEG = ("没有", "没", "未", "不", "别", "无法")
# 名字前面这些词出现时，名字多半是**听的人**，不是说话的人
_ADDRESS_BEFORE = ("对着", "冲着", "朝着", "望着", "看着", "盯着", "问着", "向", "对", "冲", "朝", "跟", "和", "与")
# 名字后面这些词出现时，是「听见/传来」而不是「说」
_NON_SPEECH_TAIL = ("传来", "听到", "听见", "只听", "低声传来")

# 不能当名字组成部分的常用字（动词 / 名词 / 助词）
_BAD_IN_NAME = set(
    "的了着过很都也就在是有不没和与及或将被把让给对向从到个这那他她它我你您们吗呢吧啊呀哦嗯"
    "说问道问答看听笑哭喊叫走跑站坐起下上中里外时后前又再还只更最太非常已经正在做"
    "声音话气神头手眼口脚身心命事物体面点分秒时刻天年日号次回趟遍些种样类"
)
# 常见「像名字其实不是」的词（避免把人称/时间词当角色）
_STOP_NAMES = set(
    "自己 我们 他们 你们 大家 别人 人家 对方 那人 这人 有人 没人 时间 现在 刚才 之后 以前 "
    "心里 心里想 小声 大声 低声 轻声 好声 冷声 沉声 柔声 语声 一声 两声 半晌 片刻 众人".split()
)
# 复姓
_COMPOUND = (
    "欧阳", "太史", "端木", "上官", "司马", "东方", "独孤", "南宫", "万俟", "闻人", "夏侯", "诸葛",
    "尉迟", "公羊", "赫连", "澹台", "皇甫", "宗政", "濮阳", "公冶", "太叔", "申屠", "公孙", "慕容",
    "仲孙", "钟离", "长孙", "宇文", "司徒", "鲜于", "司空", "闾丘", "子车", "亓官", "司寇", "巫马",
)
# 单姓（够用即可，宁可少认也别乱认）
_SURNAMES = set(
    "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛"
    "奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝安常乐傅皮卞齐康伍余元卜"
    "顾孟平黄和穆萧尹姚邵汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾"
    "路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田胡凌霍虞万支柯管卢莫房裘解应宗丁宣邓郁单杭洪包诸左"
    "石崔吉龚程邢裴陆荣翁荀羊惠甄曲封芮储靳段富巫乌焦巴牧山谷车侯全班仰秋仲伊宫宁仇栾暴甘厉戎"
    "祖武符刘景詹束龙叶幸司韶黎薄印宿白怀蒲从鄂索咸赖卓蔺屠蒙池乔翟谭劳姬申扶堵冉宰雍桑桂牛寿"
    "通边燕冀浦尚农温别庄晏柴瞿阎慕连茹艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙"
    "东欧沃利蔚越隆师巩聂晁融冷辛简饶曾沙鞠丰巢关蒯查荆红游权盖益桓公墨帝夜"
)
_NICK_PREFIX = "小老阿"

_ADDRESS_RE = re.compile(
    r"([\u4e00-\u9fa5]{2,3})\s*(?:对|向|冲|朝|跟|和|与)\s*"
    r"[\u4e00-\u9fa5]{2,3}\s*(?:" + _VERBS + r")"
)
# 名字长度用**惰性**匹配（先试 2 字再放长）：贪心会把「小翠在旁边小声说」切成「小翠在旁」，
# 而惰性拿到的是「小翠」+ 修饰「在旁边小声」+ 动词「说」
_SPEAK_RE = re.compile(
    r"([\u4e00-\u9fa5]{2,4}?)[^。！？\n]{0,6}?(?:" + _VERBS + r")"
)
_COLON_RE = re.compile(r"([\u4e00-\u9fa5]{2,4})\s*[：:]\s*$")
# 「李四压低声音。」「小翠放缓了语气。」——没有说话动词，但名字 + 嗓音词就是说话人
_VOICE_RE = re.compile(
    r"([\u4e00-\u9fa5]{2,3}?)(?:压低|提高|放缓|放低|拔高)?(?:了|着)?(?:声音|嗓门|嗓子|语气|口吻)"
)
# 后置旁白常把名字放在开头、还不带说话动词：「李四压低声音。」「小翠点点头，」
_LEAD_NAME_RE = re.compile(r"^\s*(?:只见|这时|此时|随后|然后|接着)?\s*([\u4e00-\u9fa5]{2,4})")


def _bad_char(name: str) -> bool:
    return any(c in _BAD_IN_NAME for c in name)


def _plausible(name: str, known=None) -> bool:
    """这个名字像真人名吗？（宁可保守）"""
    if not name or not (2 <= len(name) <= 4):
        return False
    if name in _STOP_NAMES:
        return False
    if known and name in known:
        return True
    # 名字里混进动词/名词性的常用字，一律不认（「边小声」就是死在这条）
    if _bad_char(name):
        return False
    if name.endswith(("声", "话", "音", "气")):
        return False
    if name[:2] in _COMPOUND:
        return True
    if name[0] in _SURNAMES:
        return True
    if name[0] in _NICK_PREFIX and len(name) >= 2:
        return True
    return False


def _address_before(text: str, start: int) -> bool:
    """名字前面是不是「对着 X」这种宾语位置。"""
    head = text[max(0, start - 4):start]
    return any(head.endswith(w) for w in _ADDRESS_BEFORE)


def _neg_in_gap(gap: str) -> bool:
    return any(w in gap for w in _GAP_NEG)


def find_names(text: str, known=None) -> dict:
    """从旁白里找出「说话人候选」：{名字: 出现次数}。

    只认三种写法：
        · 张三说 / 李四冷笑道 / 小翠在旁边小声说（名字 + 修饰 + 说话动词）
        · 张三：「…」（名字 + 冒号）
        · 张三对李四说（说话人是张三，李四不算）
    """
    known = set(known or ())
    hits = {}

    def add(nm):
        n = nm.strip()
        if _plausible(n, known):
            hits[n] = hits.get(n, 0) + 1

    for m in _ADDRESS_RE.finditer(text):
        add(m.group(1))
    for m in _SPEAK_RE.finditer(text):
        cand = m.group(1)
        gap = text[m.start(1) + len(cand):m.end()]
        if _neg_in_gap(gap) or _address_before(text, m.start(1)):
            continue
        if any(t in text[m.end():m.end() + 6] for t in _NON_SPEECH_TAIL):
            continue
        add(cand)
    for m in _COLON_RE.finditer(text):
        add(m.group(1))
    for m in _VOICE_RE.finditer(text):
        add(m.group(1))
    return hits


def _leading_name(narration: str, known) -> str:
    """旁白开头的名字（不带说话动词也算）——只在「这句台词紧跟着它」时用。

    必须**已经**在全篇别处被认出来过（known），否则宁可返回空：
    「李四压低声音。」里 4 字窗口是「李四压低」，硬切会造出根本不存在的角色。
    长短从 4 试到 2，取最长的已知名字。
    """
    head = (narration or "").lstrip()
    for ln in (4, 3, 2):
        cand = head[:ln]
        if len(cand) == ln and cand in known:
            return cand
    return ""


def _name_of(narration: str, known) -> str:
    """一段旁白里提到的「说话人」——只取一个，且要过负向检查。"""
    hits = find_names(narration, known)
    if not hits:
        return ""
    # 优先取「名字 + 说话动词」的，其次按出现顺序
    for nm in hits:
        if any(nm in narration[:i + 12] for i in [narration.find(nm)]):
            return nm
    return next(iter(hits))


def attribute(pieces, known=None, allow_body_names: bool = False):
    """给每一段标说话人。

    pieces: [{"kind": "dialogue"|"narration"|"paren"|..., "text": str}, ...]
            按原文出现顺序，跨段信息就是靠这个顺序传递的。
    返回同长度的 [{"role","source","conf"}]；认不出的 role 为空字符串。

    source 取值：
        lead     前一句旁白以「：/说道」收尾（强归因，最可靠）
        after    后置旁白（「…」李四说）
        context  同一段里上文提到的人
        body     台词正文里出现的已知名字（弱证据，默认关）
        None     没线索 —— 交给调用方做交替兜底
    """
    # 先扫一遍全篇旁白，得到「已知名字」；后置旁白里没动词的名字必须在这张表里才采信
    lex = set(known or ())
    lead_count = {}
    for p in pieces:
        if (p.get("kind") or "") != "dialogue":
            txt = p.get("text") or ""
            lex |= set(find_names(txt, lex))
            # 旁白开头的人名（「张三推开门」「张三把外套…」）单看一次不可靠，
            # 但同一篇里出现两次以上就基本是角色了 —— 这类名字认出来以后，
            # 后置旁白里的「张三把外套挂在椅背上」才能对上人
            head = txt.lstrip()[:2]
            if len(head) == 2 and _plausible(head, lex) and not _address_before(txt.lstrip(), 0):
                lead_count[head] = lead_count.get(head, 0) + 1
    for nm, n in lead_count.items():
        if n >= 2:
            lex.add(nm)
    known = set(lex)
    out = [{"role": "", "source": "", "conf": 0.0} for _ in pieces]
    pending = ""
    pending_strong = False

    for i, p in enumerate(pieces):
        kind = p.get("kind") or "narration"
        text = p.get("text") or ""
        if kind != "dialogue":
            nm = _name_of(text, known)
            if nm:
                pending = nm
                known.add(nm)
            pending_strong = bool(
                re.search(r"[：:]\s*$", text)
                or re.search(r"(?:" + _VERBS + r")\s*[，,]?\s*$", text)
            )
            continue

        role, src, conf = "", "", 0.0

        # ① 上文旁白以「：」或「说道」收尾 → 直接采信
        if pending and pending_strong:
            role, src, conf = pending, "lead", 0.95

        # ② 后置旁白：紧跟在本段后面的旁白里找「李四说」
        if not role and i + 1 < len(pieces):
            nxt = pieces[i + 1]
            if (nxt.get("kind") or "") != "dialogue":
                txt = nxt.get("text") or ""
                nm = _name_of(txt, known)
                if nm:
                    role, src, conf = nm, "after", 0.85
                else:
                    nm = _leading_name(txt, lex)        # 「李四压低声音。」这种没动词的
                    if nm:
                        role, src, conf = nm, "after", 0.65

        # ③ 同一段上文提到的人（弱一点：可能换人了）
        if not role and pending:
            role, src, conf = pending, "context", 0.7

        # ④ 台词正文里出现的已知名字（最弱，默认关：`"张三那人靠不住。"` 会反）
        if not role and allow_body_names and known:
            hit = [n for n in known if n in text]
            if len(hit) == 1:
                role, src, conf = hit[0], "body", 0.5

        out[i] = {"role": role, "source": src, "conf": conf}
        if role:
            pending = role
            known.add(role)
            pending_strong = False

    return out
