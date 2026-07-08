#!/usr/bin/env python3
"""
manage_registry.py — Manage community extension/skill registry JSON files.

Usage:
  python3 manage_registry.py add <type> <json_args>
  python3 manage_registry.py update <type> <id> <json_args>
  python3 manage_registry.py deprecate <type> <id>
  python3 manage_registry.py undeprecate <type> <id>

Where <type> is "extension" or "skill".

For add/update, <json_args> is a JSON string with fields to set.

Examples:
  # Add a new skill
  python3 manage_registry.py add skill '{
    "id": "my-skill",
    "name": "My Skill",
    "author": "Me",
    "description": "Does something cool.",
    "repo": "me/my-repo",
    "categories": ["developer"]
  }'

  # Update an extension's description
  python3 manage_registry.py update extension mcp '{
    "description": "New description here."
  }'

  # Deprecate a skill
  python3 manage_registry.py deprecate skill old-skill

  # Sync zh-CN (add Chinese name/description for an entry)
  python3 manage_registry.py update extension mcp '{
    "name_zh": "MCP 桥接",
    "description_zh": "连接 MCP 服务..."
  }'
"""
import json
import os
import sys
import copy

REPO_ROOT = os.environ.get("REPO_ROOT", os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
COMMUNITY_DIR = os.path.join(REPO_ROOT, "community")

EN_FILE = {
    "extension": "mini-tools.json",
    "mini-tool": "mini-tools.json",
    "skill": "skills.json",
}
ZH_FILE = {
    "extension": "mini-tools.zh-CN.json",
    "mini-tool": "mini-tools.zh-CN.json",
    "skill": "skills.zh-CN.json",
}

VALID_CATEGORIES = {"productivity", "developer", "creative", "research", "finance", "commerce", "education"}


def read_json(path):
    with open(path) as f:
        return json.load(f)


def write_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def load_both(reg_type):
    """Load both EN and ZH files."""
    return (
        read_json(os.path.join(COMMUNITY_DIR, EN_FILE[reg_type])),
        read_json(os.path.join(COMMUNITY_DIR, ZH_FILE[reg_type])),
    )


def save_both(reg_type, en_data, zh_data):
    """Save both EN and ZH files."""
    # Sort by id
    en_data.sort(key=lambda x: x["id"])
    zh_data.sort(key=lambda x: x["id"])

    write_json(os.path.join(COMMUNITY_DIR, EN_FILE[reg_type]), en_data)
    write_json(os.path.join(COMMUNITY_DIR, ZH_FILE[reg_type]), zh_data)


def cmd_add(reg_type, args):
    """Add a new entry."""
    en_data, zh_data = load_both(reg_type)

    eid = args.get("id")
    if not eid:
        print("ERROR: 'id' is required")
        sys.exit(1)

    # Check uniqueness
    if any(e["id"] == eid for e in en_data):
        print(f"ERROR: Entry '{eid}' already exists in {EN_FILE[reg_type]}")
        sys.exit(1)

    # Validate categories
    cats = args.get("categories", [])
    invalid = [c for c in cats if c not in VALID_CATEGORIES]
    if invalid:
        print(f"ERROR: Invalid categories: {invalid}")
        sys.exit(1)

    # Build EN entry
    en_entry = {}
    for field in ["id", "name", "author", "description", "repo", "npm", "extensionType", "installScope", "categories", "featured"]:
        if field in args:
            en_entry[field] = args[field]
    if "deprecated" in args:
        en_entry["deprecated"] = args["deprecated"]

    # Build ZH entry
    zh_entry = {"id": eid}
    if args.get("name_zh"):
        zh_entry["name"] = args["name_zh"]
    if args.get("description_zh"):
        zh_entry["description"] = args["description_zh"]

    en_data.append(en_entry)
    zh_data.append(zh_entry)
    save_both(reg_type, en_data, zh_data)

    print(f"ADDED: {reg_type} '{eid}'")


def cmd_update(reg_type, eid, args):
    """Update an existing entry."""
    en_data, zh_data = load_both(reg_type)

    # Find entry
    en_entry = None
    for e in en_data:
        if e["id"] == eid:
            en_entry = e
            break

    if not en_entry:
        print(f"ERROR: Entry '{eid}' not found in {EN_FILE[reg_type]}")
        sys.exit(1)

    # Update EN fields
    en_fields = ["name", "author", "description", "repo", "npm", "extensionType", "installScope", "featured"]
    for field in en_fields:
        if field in args:
            en_entry[field] = args[field]

    if "categories" in args:
        cats = args["categories"]
        invalid = [c for c in cats if c not in VALID_CATEGORIES]
        if invalid:
            print(f"ERROR: Invalid categories: {invalid}")
            sys.exit(1)
        en_entry["categories"] = cats

    # Update ZH fields
    zh_entry = None
    for e in zh_data:
        if e["id"] == eid:
            zh_entry = e
            break

    if args.get("name_zh") or args.get("description_zh"):
        if not zh_entry:
            zh_entry = {"id": eid}
            zh_data.append(zh_entry)
        if args.get("name_zh"):
            zh_entry["name"] = args["name_zh"]
        if args.get("description_zh"):
            zh_entry["description"] = args["description_zh"]

    save_both(reg_type, en_data, zh_data)
    print(f"UPDATED: {reg_type} '{eid}'")


def cmd_deprecate(reg_type, eid):
    """Mark an entry as deprecated."""
    en_data, zh_data = load_both(reg_type)

    en_entry = None
    for e in en_data:
        if e["id"] == eid:
            en_entry = e
            break

    if not en_entry:
        print(f"ERROR: Entry '{eid}' not found in {EN_FILE[reg_type]}")
        sys.exit(1)

    en_entry["deprecated"] = True
    save_both(reg_type, en_data, zh_data)
    print(f"DEPRECATED: {reg_type} '{eid}'")


def cmd_undeprecate(reg_type, eid):
    """Remove deprecated flag."""
    en_data, zh_data = load_both(reg_type)

    en_entry = None
    for e in en_data:
        if e["id"] == eid:
            en_entry = e
            break

    if not en_entry:
        print(f"ERROR: Entry '{eid}' not found in {EN_FILE[reg_type]}")
        sys.exit(1)

    if "deprecated" in en_entry:
        del en_entry["deprecated"]
    save_both(reg_type, en_data, zh_data)
    print(f"UNDEPRECATED: {reg_type} '{eid}'")


def cmd_remove(reg_type, eid):
    """Remove an entry from both EN and ZH registries."""
    en_data, zh_data = load_both(reg_type)

    en_before = len(en_data)
    en_data = [e for e in en_data if e["id"] != eid]
    zh_data = [e for e in zh_data if e["id"] != eid]

    if len(en_data) == en_before:
        print(f"ERROR: Entry '{eid}' not found in {EN_FILE[reg_type]}")
        sys.exit(1)

    save_both(reg_type, en_data, zh_data)
    print(f"REMOVED: {reg_type} '{eid}'")


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]
    reg_type = sys.argv[2]

    if reg_type not in ("extension", "skill", "mini-tool"):
        print(f"ERROR: Type must be 'extension', 'mini-tool', or 'skill', got '{reg_type}'")
        sys.exit(1)

    if cmd in ("add", "update"):
        if len(sys.argv) < 4:
            print(f"ERROR: '{cmd}' requires JSON args")
            sys.exit(1)
        try:
            args = json.loads(sys.argv[3])
        except json.JSONDecodeError as e:
            print(f"ERROR: Invalid JSON: {e}")
            sys.exit(1)

        if cmd == "add":
            cmd_add(reg_type, args)
        else:
            eid = sys.argv[3] if len(sys.argv) >= 4 else ""
            if cmd == "update":
                if len(sys.argv) < 5:
                    print(f"ERROR: 'update' requires id and JSON args")
                    sys.exit(1)
                cmd_update(reg_type, sys.argv[3], json.loads(sys.argv[4]))

    elif cmd in ("deprecate", "undeprecate"):
        if len(sys.argv) < 4:
            print(f"ERROR: '{cmd}' requires id")
            sys.exit(1)
        if cmd == "deprecate":
            cmd_deprecate(reg_type, sys.argv[3])
        else:
            cmd_undeprecate(reg_type, sys.argv[3])

    elif cmd == "remove":
        if len(sys.argv) < 4:
            print(f"ERROR: 'remove' requires id")
            sys.exit(1)
        cmd_remove(reg_type, sys.argv[3])

    else:
        print(f"ERROR: Unknown command '{cmd}'")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
