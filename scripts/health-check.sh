#!/bin/bash
# agentcord 健康检查和自动重启脚本
# 用途：检查 daemon 服务是否存活，如果挂了就自动重启

set -e

LOG_FILE="$HOME/.threadcord/health-check.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

log() {
    echo "[$TIMESTAMP] $1" | tee -a "$LOG_FILE"
}

# 检查 daemon 是否在运行
check_daemon() {
    if launchctl list | grep -q "com.threadcord"; then
        # 检查进程是否真的在运行
        local pid=$(launchctl list | grep com.threadcord | awk '{print $1}')
        if [ "$pid" != "-" ] && [ -n "$pid" ]; then
            log "✅ Daemon is running (PID: $pid)"
            return 0
        fi
    fi
    log "❌ Daemon is not running"
    return 1
}

# 检查 bot 是否响应（通过检查锁文件和进程）
check_bot_alive() {
    local lock_file="$HOME/.threadcord/bot.lock"

    if [ ! -f "$lock_file" ]; then
        log "⚠️  Lock file not found"
        return 1
    fi

    local pid=$(cat "$lock_file")
    if ps -p "$pid" > /dev/null 2>&1; then
        log "✅ Bot process is alive (PID: $pid)"
        return 0
    else
        log "❌ Bot process is dead (stale PID: $pid)"
        return 1
    fi
}

# 重启服务
restart_service() {
    log "🔄 Attempting to restart service..."

    # 卸载旧的 daemon
    threadcord daemon uninstall 2>&1 | tee -a "$LOG_FILE"

    # 清理锁文件
    rm -f "$HOME/.threadcord/bot.lock"

    # 重新安装并启动 daemon
    threadcord daemon install 2>&1 | tee -a "$LOG_FILE"

    # 等待 5 秒让服务启动
    sleep 5

    # 验证重启是否成功
    if check_daemon && check_bot_alive; then
        log "✅ Service restarted successfully"
        return 0
    else
        log "❌ Service restart failed"
        return 1
    fi
}

# 主逻辑
main() {
    log "=== Health Check Started ==="

    if check_daemon; then
        if check_bot_alive; then
            log "✅ All systems operational"
            exit 0
        else
            log "⚠️  Daemon running but bot process is dead"
            restart_service
        fi
    else
        log "⚠️  Daemon is not running"
        restart_service
    fi

    log "=== Health Check Completed ==="
}

main
