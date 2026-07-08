#!/usr/bin/env python3
"""Validate community registry JSON files."""
import json
import os
import re

repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
community_dir = os.path.join(repo_root, "community")

VALID_CATEGORIES = {"productivity", "developer", "creative", "research", "finance", "commerce", "education"}

errors = []
warnings = []
passes = []

def validate_json_file(filepath, schema_type):
    """Validate a JSON file."""
    try:
        with open(filepath) as f:
            data = json.load(f)
    except (json.JSONDecodeError, FileNotFoundError) as e:
        errors.append(f"{os.path.basename(filepath)}: 无法解析 JSON — {e}")
        return None

    if not isinstance(data, list):
        errors.append(f"{os.path.basename(filepath)}: 顶层必须是数组，当前是 {type(data).__name__}")
        return None

    passes.append(f"{os.path.basename(filepath)}: 合法 JSON 数组，{len(data)} 条条目")
    return data

def check_id_format(entries, filename):
    """Check id format."""
    for entry in entries:
        eid = entry.get("id", "")
        if not re.match(r'^[a-z0-9][a-z0-9-]*$', eid):
            errors.append(f"{filename}: 条目 `{eid}` — id 格式非法（需小写字母、数字、连字符）")
        else:
            passes.append(f"{filename}: 条目 `{eid}` — id 格式合规")

def check_id_uniqueness(entries, filename):
    """Check id uniqueness."""
    ids = [e.get("id") for e in entries if e.get("id")]
    duplicates = [eid for eid in ids if ids.count(eid) > 1]
    if duplicates:
        errors.append(f"{filename}: 重复 id — {set(duplicates)}")
    else:
        passes.append(f"{filename}: id 唯一性 — {len(ids)} 条目无重复")

def check_required_fields(entries, filename, required_fields):
    """Check required fields."""
    for entry in entries:
        eid = entry.get("id", "?")
        missing = [f for f in required_fields if f not in entry]
        if missing:
            errors.append(f"{filename}: 条目 `{eid}` — 缺少必填字段: {', '.join(missing)}")
        else:
            passes.append(f"{filename}: 条目 `{eid}` — 必填字段完整")

def check_categories(entries, filename):
    """Check categories values."""
    for entry in entries:
        eid = entry.get("id", "?")
        cats = entry.get("categories", [])
        if not cats:
            continue
        invalid = [c for c in cats if c not in VALID_CATEGORIES]
        if invalid:
            errors.append(f"{filename}: 条目 `{eid}` — 未知分类: {', '.join(invalid)}")
        else:
            passes.append(f"{filename}: 条目 `{eid}` — 分类合规 ({', '.join(cats)})")

def check_alphabetical_order(entries, filename):
    """Check if entries are sorted by id alphabetically."""
    ids = [e.get("id", "") for e in entries]
    sorted_ids = sorted(ids)
    if ids != sorted_ids:
        # Find first misplacement
        for i, (actual, expected) in enumerate(zip(ids, sorted_ids)):
            if actual != expected:
                errors.append(f"{filename}: 字母序异常 — `{actual}` 应在 `{expected}` 之后")
                return
    else:
        passes.append(f"{filename}: 字母序正确")

def check_zh_coverage(zh_entries, en_entries, zh_filename, en_filename):
    """Check zh-CN coverage."""
    en_ids = {e["id"] for e in en_entries if "id" in e}
    zh_ids = {e["id"] for e in zh_entries if "id" in e}

    missing = en_ids - zh_ids
    extra = zh_ids - en_ids

    if missing:
        warnings.append(f"{zh_filename}: 缺少中文覆盖条目 — {', '.join(sorted(missing))}（将回退到英文）")
    else:
        passes.append(f"{zh_filename}: 中英文覆盖完整（{len(en_ids)} 条目均有一一对应）")

    if extra:
        errors.append(f"{zh_filename}: 多余条目（英文已移除）— {', '.join(sorted(extra))}")

def check_extension_id_consistency(entries, filename):
    """Check extension ids match extensions/<id>/package.json#finch.id."""
    for entry in entries:
        eid = entry.get("id", "")
        pkg_path = os.path.join(repo_root, "extensions", eid, "package.json")
        if not os.path.exists(pkg_path):
            warnings.append(f"{filename}: 条目 `{eid}` — 未找到对应的 extensions/{eid}/package.json（社区扩展可忽略）")
            continue
        try:
            with open(pkg_path) as f:
                pkg = json.load(f)
            finch_id = pkg.get("finch", {}).get("id")
            if finch_id and finch_id != eid:
                errors.append(f"{filename}: 条目 `{eid}` — package.json#finch.id 为 `{finch_id}`，不匹配")
            else:
                passes.append(f"{filename}: 条目 `{eid}` — package.json#finch.id 一致")
        except (json.JSONDecodeError, FileNotFoundError):
            warnings.append(f"{filename}: 条目 `{eid}` — 无法读取 package.json")

# --- Main validation ---

print("## 校验报告\n")

# 1. Validate extensions.json
ext_data = validate_json_file(os.path.join(community_dir, "mini-tools.json"), "mini-tool")
if ext_data:
    check_id_format(ext_data, "mini-tools.json")
    check_id_uniqueness(ext_data, "mini-tools.json")
    check_required_fields(ext_data, "mini-tools.json",
        ["id", "name", "author", "description", "repo"])
    check_categories(ext_data, "mini-tools.json")
    check_alphabetical_order(ext_data, "mini-tools.json")
    check_extension_id_consistency(ext_data, "mini-tools.json")

# 2. Validate skills.json
skill_data = validate_json_file(os.path.join(community_dir, "skills.json"), "skill")
if skill_data:
    check_id_format(skill_data, "skills.json")
    check_id_uniqueness(skill_data, "skills.json")
    check_required_fields(skill_data, "skills.json",
        ["id", "name", "author", "description", "repo"])
    check_categories(skill_data, "skills.json")
    check_alphabetical_order(skill_data, "skills.json")

# 3. Validate zh-CN files
ext_zh_data = validate_json_file(os.path.join(community_dir, "mini-tools.zh-CN.json"), "mini-tool zh-CN")
skill_zh_data = validate_json_file(os.path.join(community_dir, "skills.zh-CN.json"), "skill zh-CN")

if ext_data and ext_zh_data:
    check_zh_coverage(ext_zh_data, ext_data, "mini-tools.zh-CN.json", "mini-tools.json")
if skill_data and skill_zh_data:
    check_zh_coverage(skill_zh_data, skill_data, "skills.zh-CN.json", "skills.json")

# --- Summary ---
print(f"\n### ✅ 通过 ({len(passes)})")
for p in passes:
    print(f"- {p}")

if warnings:
    print(f"\n### ⚠️ 警告 ({len(warnings)})")
    for w in warnings:
        print(f"- {w}")

if errors:
    print(f"\n### ❌ 问题 ({len(errors)})")
    for e in errors:
        print(f"- {e}")

print(f"\n---\n总计: {len(passes)} 通过, {len(warnings)} 警告, {len(errors)} 问题")
