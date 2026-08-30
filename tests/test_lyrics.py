"""services.lyrics 搜索结果最佳匹配纯函数测试（不依赖网络与数据库）。"""

from momoitor.services.lyrics import pick_best_result

# 真实 Meting 搜索返回样例（关键词「夏天 - 洛天依」），首项并非播放中的曲目
_RESULTS = [
    {"title": "Montagem pitty", "author": "见过夏天P / 洛天依",
     "lrc": "https://example.com/api?type=lrc&id=3356975915"},
    {"title": "别把夏天关掉", "author": "乐小君 / 洛天依",
     "lrc": "https://example.com/api?type=lrc&id=3414700455"},
    {"title": "夏天", "author": "洛天依 / 栖亦久",
     "lrc": "https://example.com/api?type=lrc&id=2727346621"},
    {"title": "阿Q外传", "author": "见过夏天P / 洛天依",
     "lrc": "https://example.com/api?type=lrc&id=3401050922"},
    {"title": "留座", "author": "见过夏天P / 洛天依",
     "lrc": "https://example.com/api?type=lrc&id=3336527444"},
    {"title": "破茧成光 Pt.2", "author": "见过夏天P / 洛天依",
     "lrc": "https://example.com/api?type=lrc&id=3376894533"},
]


def test_exact_title_and_artist_wins():
    best = pick_best_result(_RESULTS, "夏天", "洛天依 / 栖亦久")
    assert best["title"] == "夏天"
    assert best["author"] == "洛天依 / 栖亦久"


def test_artist_separator_and_order_tolerated():
    best = pick_best_result(_RESULTS, "别把夏天关掉", "乐小君、洛天依")
    assert best["title"] == "别把夏天关掉"


def test_no_artist_still_matches_title():
    best = pick_best_result(_RESULTS, "夏天", "")
    assert best["title"] == "夏天"


def test_smtc_title_with_noise_suffix():
    best = pick_best_result(_RESULTS, "夏天 (Official Audio)", "洛天依 / 栖亦久")
    assert best["title"] == "夏天"


def test_no_match_falls_back_to_first():
    best = pick_best_result(_RESULTS, "完全不存在的歌名xyz", "无名氏")
    assert best == _RESULTS[0]


def test_malformed_items_are_skipped():
    results = [None, "garbage", {"title": "夏天", "author": "洛天依 / 栖亦久", "lrc": "u"}]
    assert pick_best_result(results, "夏天", "洛天依")["lrc"] == "u"


def test_empty_or_invalid_results():
    assert pick_best_result([], "x") == {}
    assert pick_best_result(None, "x") == {}


# 真实案例「欲泪海 - MOCKER44.」：曲名完全一致的合唱原曲，必须胜过歌手
# 完全一致的「歌名+后缀」变体（beat/伴奏/Remix）——曲名分层优先于歌手加权分
_BEAT_RESULTS = [
    {"title": "欲泪海", "author": "MOCKER44. / 洛天依", "lrc": "u1"},
    {"title": "欲泪海（Feat.卫锲）", "author": "MOCKER44. / 卫锲", "lrc": "u2"},
    {"title": "breeze of early autumn", "author": "MOCKER44.", "lrc": "u3"},
    {"title": "雾林鸟", "author": "MOCKER44. / 洛天依", "lrc": "u4"},
    {"title": "欲泪海 beat", "author": "MOCKER44.", "lrc": "u5"},
]


def test_exact_title_beats_title_suffix_variant():
    best = pick_best_result(_BEAT_RESULTS, "欲泪海", "MOCKER44.")
    assert best["lrc"] == "u1"


def test_exact_title_and_artist_beats_exact_title_other_artist():
    # 同为曲名完全一致时，歌手更匹配者优先：播放 MOCKER44. 的版本，
    # 不应选到他人翻唱（亦水Akra 等）
    results = [
        {"title": "欲泪海", "author": "MOCKER44. / 洛天依", "lrc": "orig"},
        {"title": "欲泪海", "author": "亦水Akra", "lrc": "cover"},
        {"title": "欲泪海", "author": "白晏迟", "lrc": "cover2"},
    ]
    assert pick_best_result(results, "欲泪海", "MOCKER44.")["lrc"] == "orig"
