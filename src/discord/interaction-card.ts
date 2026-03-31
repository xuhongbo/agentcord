// 交互卡：等待人工处理的按钮界面
// 参考设计文档 5.3

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type TextChannel,
  type AnyThreadChannel,
} from 'discord.js';

export class InteractionCard {
  private channel: TextChannel | AnyThreadChannel;
  private messageId: string | null = null;

  constructor(channel: TextChannel | AnyThreadChannel) {
    this.channel = channel;
  }

  async show(sessionId: string, turn: number, detail: string): Promise<string> {
    const customIdBase = `awaiting_human:${sessionId}:${turn}`;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${customIdBase}:approve`)
        .setLabel('允许继续')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${customIdBase}:deny`)
        .setLabel('拒绝')
        .setStyle(ButtonStyle.Danger),
    );

    const embed = new EmbedBuilder()
      .setTitle('⏸️ 等待人工处理')
      .setDescription(detail)
      .setColor(0xffaa00)
      .setTimestamp();

    await this.hide();
    const message = await this.channel.send({ embeds: [embed], components: [row] });
    this.messageId = message.id;
    return message.id;
  }

  async hide(): Promise<void> {
    if (!this.messageId) return;

    try {
      await this.channel.messages.edit(this.messageId, { components: [] });
    } catch {
      // 消息可能已被删除，忽略
    } finally {
      this.messageId = null;
    }
  }
}
