// 常驻状态卡：固定在频道顶部的状态展示
// 参考设计文档 5.1

import {
  EmbedBuilder,
  type TextChannel,
  type AnyThreadChannel,
  type Message,
} from 'discord.js';
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
    const payload = {
      turn: data.turn ?? 1,
      updatedAt: data.updatedAt ?? Date.now(),
      phase: data.phase,
    };

    if (this.messageId) {
      await this.update('idle', payload);
      return;
    }

    const embed = this.buildEmbed('idle', payload);
    await this.sendNewMessage(embed);
  }

  async update(state: UnifiedState, data: { turn: number; updatedAt: number; phase?: string }): Promise<void> {
    const embed = this.buildEmbed(state, data);
    if (!this.messageId) {
      await this.sendNewMessage(embed);
      return;
    }
    await this.editExistingMessage(embed);
  }

  private async sendNewMessage(embed: EmbedBuilder): Promise<void> {
    const msg = await this.channel.send({ embeds: [embed] });
    this.messageId = msg.id;
    await msg.pin().catch(() => {
      // Pin 失败视为降级，状态卡仍然继续工作
    });
  }

  private async editExistingMessage(embed: EmbedBuilder): Promise<void> {
    if (!this.messageId) {
      await this.sendNewMessage(embed);
      return;
    }

    try {
      const msg = await this.channel.messages.edit(this.messageId, {
        embeds: [embed],
        components: [],
      });
      this.messageId = msg.id;
      await msg.pin().catch(() => {
        // Pin 失败视为降级
      });
    } catch {
      await this.sendNewMessage(embed);
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
      this.validate(data.phase);
      embed.addFields({ name: '阶段', value: data.phase, inline: true });
    }

    return embed;
  }

  validate(description?: string): void {
    if (!description) return;
    const normalized = description.trim();
    if (!normalized) return;

    if (normalized.length > 200) {
      throw new Error('状态卡描述过长，应移至摘要卡或结果消息');
    }
    if (normalized.includes('```')) {
      throw new Error('状态卡不应包含代码块');
    }
    if (/diff --git/.test(normalized)) {
      throw new Error('状态卡不应包含 diff');
    }
    if (this.isLikelyFileList(normalized)) {
      throw new Error('状态卡不应包含文件列表');
    }
  }

  private isLikelyFileList(text: string): boolean {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length < 2) return false;
    return lines.every((line) => /^[-+*]\s+[\w./\\-]+$/.test(line));
  }
}
