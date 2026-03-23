# Claude Instructions — randomchat-server

## Memory Location

Store all persistent memory files in the Obsidian vault:

- **Memory root:** `C:\Users\sai\Desktop\obsidian\memory\Claude Memory\`
- **Index file:** `C:\Users\sai\Desktop\obsidian\memory\Claude Memory\MEMORY.md`
- **Individual files:** `C:\Users\sai\Desktop\obsidian\memory\Claude Memory\<name>.md`

Use this path instead of the default `C:\Users\sai\.claude\projects\...\memory\` for all memory reads and writes. This makes Claude memories visible and editable directly inside Obsidian.

Memory file format:
```markdown
---
name: <memory name>
description: <one-line description>
type: <user | feedback | project | reference>
---

<content>
```
