// 常驻状态卡：固定在频道顶部的状态展示
// 参考设计文档 5.1

import { EmbedBuilder, type TextChannel, type AnyThreadChannel } from 'discord.js';
import type { UnifiedState } from '../state/types.ts';
import { STATE_LABELS, STATE_COLORS } from '../state/types.ts';

export class StatusCard {
  private messageId: string | null = null;
  private channel: TextChannel | AnyThreadChannel;

  constructor(channel: TextChannel | AnyThreadChannel) {
    this.channel = channel;
  }

  adopt(messageId: string): void {
    this.messageId = messageId;
  }

  getMessageId(): string | null {
    return this.messageId;
  }

  async initialize(data: { turn?: number; updatedAt?: number; phase?: string } = {}): Promise<void> {
    if (this.messageId) {
      await this.update('idle', {
        turn: data.turn ?? 1,
        updatedAt: data.updatedAt ?? Date.now(),
        phase: data.phase,
      });
      return;
    }

    const embed = this.buildEmbed('idle', {
      turn: data.turn ?? 1,
      updatedAt: data.updatedAt ?? Date.now(),
      phase: data.phase,
    });
    const msg = await this.channel.send({ embeds: [embed] });
    this.messageId = msg.id;
    await msg.pin().catch(() => {});
  }

  async update(state: UnifiedState, data: { turn: number; updatedAt: number; phase?: string }): Promise<void> {
    if (!this.messageId) {
      const embed = this.buildEmbed(state, data);
      const msg = await this.channel.send({ embeds: [embed] });
      this.messageId = msg.id;
      await msg.pin().catch(() => {});
      return;
    }

    const embed = this.buildEmbed(state, data);
    try {
      await this.channel.messages.edit(this.messageId, { embeds: [embed] });
    } catch {
      const msg = await this.channel.send({ embeds: [embed] });
      this.messageId = msg.id;
      await msg.pin().catch(() => {});
    }
  }

  private buildEmbed(state: UnifiedState, data: { turn: number; updatedAt: number; phase?: string }): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setColor(STATE_COLORS[state])
      .setTitle(`🤖 ${STATE_LABELS[state]}`)
      .addFields(
        { name: '轮次', value: `#${data.turn}`, inline: true },
        { name: '更新', value: `<t:${Math.floor(data.updatedAt / 1000)}:R>`, inline: true }
      )
      .setTimestamp();

    if (data.phase) {
      embed.addFields({ name: '阶段', value: data.phase, inline: true });
    }

    return embed;
  }

  validate(description: string): void {
    if (description.length > 200) {
      throw new Error('状态卡描述过长，应移至摘要卡或结果消息');
    }
    if (description.includes('```')) {
      throw new Error('状态卡不应包含代码块');
    }
  }
}
