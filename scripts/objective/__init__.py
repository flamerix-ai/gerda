"""Mod-agnostic objective engine for the bot.

The engine (`core`) knows NOTHING about Minecraft, mods, or FTB Quests — it speaks
only Objective / Requirement / Effect and the ObjectiveSource protocol, delegating
requirement satisfaction to injected resolvers. All game/mod specifics live in
adapters under `sources/` (FTB Quests today; our own goals via `local_goals`) and
in the resolvers in `acquire`. Swapping modpacks or games = a new source + resolvers;
the loop is untouched. See docs: the approved plan (objective engine, FTB first adapter).
"""
