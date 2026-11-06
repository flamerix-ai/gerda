"""ObjectiveSource adapters — the ONLY mod/game-coupled code in the engine.

Each module here implements core.ObjectiveSource. Swapping modpacks or games means
writing a new one; the engine in `core` never changes. Today: `ftb_quests` (Monifactory
FTB Quests) and `local_goals` (our own objectives, zero mod dependency).
"""
