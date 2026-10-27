import React, { useEffect, useState } from 'react';
import { Button, Space, Tag } from 'antd';
import { MailOutlined, MessageOutlined } from '@ant-design/icons';
import { api, isDesktop } from './api.js';
import './source-setup.css';

export default function SourceShortcuts({ sources = [], navigate, busy }) {
  const [runtime, setRuntime] = useState(null);
  useEffect(() => { let alive = true; if (isDesktop()) api('runtime.dingtalkStatus').then(value => { if (alive) setRuntime(value); }).catch(() => { if (alive) setRuntime({ message: '工具状态尚未确认，可进入钉钉配置重新检测。' }); }); return () => { alive = false; }; }, []);
  const rows = [{ platform: 'email', title: '邮箱配置', icon: <MailOutlined />, description: '新来源默认使用阿里企业邮，填写本人邮箱账号和三方客户端安全密码；其他邮箱可修改服务器。一条来源对应一个邮件文件夹。' }, { platform: 'dingtalk', title: '钉钉消息来源', icon: <MessageOutlined />, description: '先准备兼容工具，再由本人完成企业授权，指定组织身份、群会话与首次读取时间。' }];
  return <section className="content-panel source-shortcuts" aria-label="邮箱与钉钉配置入口"><div className="section-heading"><div><h2>消息来源配置</h2><p>邮箱和钉钉在这里进入同一份来源配置，保存后可检测连接，再整理消息。</p></div></div>
    {rows.map(row => { const list = sources.filter(source => source.platform === row.platform); const enabled = list.filter(source => source.enabled).length; const success = list.filter(source => source.lastSuccessAt).length; return <div className="source-shortcut-row" key={row.platform}><div className="source-shortcut-icon" aria-hidden="true">{row.icon}</div><div className="source-shortcut-copy"><h3>{row.title}</h3><p>{row.description}</p><Space wrap>{list.length ? <Tag color={success ? 'green' : 'gold'}>{list.length} 个来源 · {enabled} 个启用{success ? ` · ${success} 个有完整读取记录` : ' · 尚无完整读取记录'}</Tag> : <Tag>尚未添加</Tag>}{row.platform === 'dingtalk' && <Tag color={runtime?.installed && runtime?.compatible ? 'green' : 'default'}>{runtime?.installed && runtime?.compatible ? `官方工具 V${runtime.version} 已准备` : runtime ? '采集工具待检测或准备' : '正在检测工具'}</Tag>}</Space>{row.platform === 'dingtalk' && <p className="muted">{runtime?.message || '只检测本机工具，不会读取聊天或替你登录。'}</p>}</div><Button disabled={!!busy} onClick={() => navigate('sources', { platform: row.platform, open: true })}>{list.length ? '查看与配置' : '开始配置'}</Button></div>; })}
  </section>;
}
