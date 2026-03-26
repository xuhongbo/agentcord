import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
  type AnyThreadChannel,
} from 'discord.js';

type SessionChannel = TextChannel | AnyThreadChannel;
import { config } from './config.ts';
import * as sessions from './thread-manager.ts';
import {
  getExpandableContent,
  makeModeButtons,
  setPendingAnswer,
  getPendingAnswers,
  clearPendingAnswers,
  getQuestionCount,
} from './output-handler.ts';
import { executeSessionContinue, executeSessionPrompt } from './session-executor.ts';
import { isUserAllowed, truncate } from './utils.ts';

export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  if (!isUserAllowed(interaction.user.id, config.allowedUsers, config.allowAllUsers)) {
    await interaction.reply({ content: 'Not authorized.', ephemeral: true });
    return;
  }

  const customId = interaction.customId;

  // Stop button
  if (customId.startsWith('stop:')) {
    const sessionId = customId.slice(5);
    const stopped = sessions.abortSession(sessionId);
    await interaction.reply({
      content: stopped ? 'Generation stopped.' : 'Session was not generating.',
      ephemeral: true,
    });
    return;
  }

  // Continue button
  if (customId.startsWith('continue:')) {
    const sessionId = customId.slice(9);
    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }
    if (session.isGenerating) {
      await interaction.reply({ content: 'Session is already generating.', ephemeral: true });
      return;
    }
    await interaction.deferReply();
    try {
      const channel = interaction.channel as SessionChannel;
      await interaction.editReply('Continuing...');
      await executeSessionContinue(session, channel);
    } catch (err: unknown) {
      await interaction.editReply(`Error: ${(err as Error).message}`);
    }
    return;
  }

  // Expand button
  if (customId.startsWith('expand:')) {
    const contentId = customId.slice(7);
    const content = getExpandableContent(contentId);
    if (!content) {
      await interaction.reply({ content: 'Content expired.', ephemeral: true });
      return;
    }
    const display = truncate(content, 1950);
    await interaction.reply({ content: `\`\`\`\n${display}\n\`\`\``, ephemeral: true });
    return;
  }

  // Option buttons (numbered choices)
  if (customId.startsWith('option:')) {
    const parts = customId.split(':');
    const sessionId = parts[1];
    const optionIndex = parseInt(parts[2], 10);
    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }
    const optionText = `${optionIndex + 1}`;
    await interaction.deferReply();
    try {
      const channel = interaction.channel as SessionChannel;
      await interaction.editReply(`Selected option ${optionIndex + 1}`);
      await executeSessionPrompt(session, channel, optionText);
    } catch (err: unknown) {
      await interaction.editReply(`Error: ${(err as Error).message}`);
    }
    return;
  }

  // Multi-question: collect an answer without submitting
  if (customId.startsWith('pick:')) {
    const parts = customId.split(':');
    const sessionId = parts[1];
    const questionIndex = parseInt(parts[2], 10);
    const answer = parts.slice(3).join(':');
    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }
    setPendingAnswer(sessionId, questionIndex, answer);
    const totalQuestions = getQuestionCount(sessionId);
    const pending = getPendingAnswers(sessionId);
    const answeredCount = pending?.size || 0;

    try {
      const original = interaction.message;
      const updatedComponents = original.components.map((row: any) => {
        const firstComponent = row.components?.[0];
        if (!firstComponent?.customId?.startsWith('pick:')) return row;
        const rowQi = parseInt(firstComponent.customId.split(':')[2], 10);
        if (rowQi !== questionIndex) return row;
        const newRow = new ActionRowBuilder<ButtonBuilder>();
        for (const btn of row.components) {
          const btnAnswer = btn.customId.split(':').slice(3).join(':');
          const isSelected = btnAnswer === answer;
          newRow.addComponents(
            new ButtonBuilder()
              .setCustomId(btn.customId)
              .setLabel(btn.label)
              .setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Secondary),
          );
        }
        return newRow;
      });
      await original.edit({ components: updatedComponents as any });
    } catch { /* message may be deleted */ }

    await interaction.reply({
      content: `Selected for Q${questionIndex + 1}: **${truncate(answer, 100)}** (${answeredCount}/${totalQuestions} answered)`,
      ephemeral: true,
    });
    return;
  }

  // Multi-question: submit all collected answers
  if (customId.startsWith('submit-answers:')) {
    const sessionId = customId.slice(15);
    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }
    const totalQuestions = getQuestionCount(sessionId);
    const pending = getPendingAnswers(sessionId);
    if (!pending || pending.size === 0) {
      await interaction.reply({ content: 'No answers selected yet.', ephemeral: true });
      return;
    }
    const answerLines: string[] = [];
    for (let i = 0; i < totalQuestions; i++) {
      answerLines.push(`Q${i + 1}: ${pending.get(i) || '(no answer)'}`);
    }
    const combined = answerLines.join('\n');
    clearPendingAnswers(sessionId);
    await interaction.deferReply();
    try {
      const channel = interaction.channel as SessionChannel;
      await interaction.editReply(`Submitted answers:\n${combined}`);
      await executeSessionPrompt(session, channel, combined);
    } catch (err: unknown) {
      await interaction.editReply(`Error: ${(err as Error).message}`);
    }
    return;
  }

  // AskUserQuestion answer buttons (single question)
  if (customId.startsWith('answer:')) {
    const parts = customId.split(':');
    const sessionId = parts[1];
    const hasQuestionIndex = /^\d+$/.test(parts[2]);
    const answer = hasQuestionIndex ? parts.slice(3).join(':') : parts.slice(2).join(':');
    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }
    await interaction.deferReply();
    try {
      const channel = interaction.channel as SessionChannel;
      await interaction.editReply(`Answered: **${truncate(answer, 100)}**`);
      await executeSessionPrompt(session, channel, answer);
    } catch (err: unknown) {
      await interaction.editReply(`Error: ${(err as Error).message}`);
    }
    return;
  }

  // Confirm buttons (yes/no)
  if (customId.startsWith('confirm:')) {
    const parts = customId.split(':');
    const sessionId = parts[1];
    const answer = parts[2];
    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }
    await interaction.deferReply();
    try {
      const channel = interaction.channel as SessionChannel;
      await interaction.editReply(`Answered: ${answer}`);
      await executeSessionPrompt(session, channel, answer);
    } catch (err: unknown) {
      await interaction.editReply(`Error: ${(err as Error).message}`);
    }
    return;
  }

  // Mode switch buttons
  if (customId.startsWith('mode:')) {
    const parts = customId.split(':');
    const sessionId = parts[1];
    const newMode = parts[2] as 'auto' | 'plan' | 'normal' | 'monitor';
    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }
    sessions.setMode(sessionId, newMode);
    const labels: Record<string, string> = {
      auto: '⚡ Auto — full autonomy',
      plan: '📋 Plan — plans before changes',
      normal: '🛡️ Normal — asks before destructive ops',
      monitor: '🧠 Monitor — keeps steering toward completion',
    };
    await interaction.reply({
      content: `Mode switched to **${labels[newMode]}**`,
      ephemeral: true,
    });
    try {
      const original = interaction.message;
      const updatedComponents = original.components.map((row: any) => {
        const first = row.components?.[0];
        if (first?.customId?.startsWith('mode:')) {
          return makeModeButtons(sessionId, newMode);
        }
        return row;
      });
      await original.edit({ components: updatedComponents as any });
    } catch { /* message may be deleted */ }
    return;
  }

  await interaction.reply({ content: 'Unknown button.', ephemeral: true });
}

export async function handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!isUserAllowed(interaction.user.id, config.allowedUsers, config.allowAllUsers)) {
    await interaction.reply({ content: 'Not authorized.', ephemeral: true });
    return;
  }

  const customId = interaction.customId;

  if (customId.startsWith('pick-select:')) {
    const parts = customId.split(':');
    const sessionId = parts[1];
    const questionIndex = parseInt(parts[2], 10);
    const selected = interaction.values[0];
    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }
    setPendingAnswer(sessionId, questionIndex, selected);
    const totalQuestions = getQuestionCount(sessionId);
    const pending = getPendingAnswers(sessionId);
    const answeredCount = pending?.size || 0;

    try {
      const original = interaction.message;
      const updatedComponents = original.components.map((row: any) => {
        const comp = row.components?.[0];
        if (comp?.customId !== customId) return row;
        const menu = new StringSelectMenuBuilder()
          .setCustomId(customId)
          .setPlaceholder(`Selected: ${selected.slice(0, 80)}`);
        for (const opt of comp.options) {
          menu.addOptions({
            label: opt.label,
            description: opt.description || undefined,
            value: opt.value,
            default: opt.value === selected,
          });
        }
        return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
      });
      await original.edit({ components: updatedComponents as any });
    } catch { /* message may be deleted */ }

    await interaction.reply({
      content: `Selected for Q${questionIndex + 1}: **${truncate(selected, 100)}** (${answeredCount}/${totalQuestions} answered)`,
      ephemeral: true,
    });
    return;
  }

  if (customId.startsWith('answer-select:')) {
    const afterPrefix = customId.slice(14);
    const sessionId = afterPrefix.includes(':') ? afterPrefix.split(':')[0] : afterPrefix;
    const selected = interaction.values[0];
    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }
    await interaction.deferReply();
    try {
      const channel = interaction.channel as SessionChannel;
      await interaction.editReply(`Answered: **${truncate(selected, 100)}**`);
      await executeSessionPrompt(session, channel, selected);
    } catch (err: unknown) {
      await interaction.editReply(`Error: ${(err as Error).message}`);
    }
    return;
  }

  if (customId.startsWith('select:')) {
    const sessionId = customId.slice(7);
    const selected = interaction.values[0];
    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }
    await interaction.deferReply();
    try {
      const channel = interaction.channel as SessionChannel;
      await interaction.editReply(`Selected: ${truncate(selected, 100)}`);
      await executeSessionPrompt(session, channel, selected);
    } catch (err: unknown) {
      await interaction.editReply(`Error: ${(err as Error).message}`);
    }
    return;
  }

  await interaction.reply({ content: 'Unknown selection.', ephemeral: true });
}
