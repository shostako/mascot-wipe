# mascot-wipe

Windows の Claude Code のターミナルの右上に、透過のマスコットを浮かせる Mod。返答の感情と作業の状態に合わせて顔が替わる。

## 動作環境

- Windows 版の Claude Code（WSL とデスクトップアプリでは何もしない）
- Windows Terminal、PowerShell やコマンドプロンプトの窓
- 追加のインストールは不要（Windows に入っている PowerShell 5.1 で動く）

## インストール

```
/plugin install mascot-wipe --marketplace shostako/mascot-wipe
```

## 使い方

- `/mascot off`：このセッションのマスコットを消す
- `/mascot on`：出し直す
- `/mascot status`：顔が出ないときの確認（窓の特定と小窓の状態）

## 知っておくこと

- Windows Terminal では、選択中のタブのタイトルでセッションを見分ける。タブを切り替えると顔も替わり、Claude Code のいないタブでは消える。
- タイトルが同じタブは見分けられないので、最後に入力したセッションの顔を出す。起動時に `claude -n 名前` で名前を分けると見分けられる。
- プロファイルの `suppressApplicationTitle` でタブのタイトルを固定していると比較できないので、同じ窓のどのタブにも、最後に入力したセッションの顔が出る。
- マスコットは窓の上に重なるが、クリックは下の窓に通る。
- 感情の印のために、入力ごとに短い指示を足す。そのぶん少しトークンを使う。
- スクリプトの実行が会社の設定で止められている PC では動かない。

## ライセンス

コードは MIT、`frames/` の絵は CC0。

## English

A mod for Claude Code on Windows. A transparent mascot floats at the top right of your terminal window and changes its face with the reply and the work.

- **Works with:** the Windows build of Claude Code in Windows Terminal, PowerShell and Command Prompt windows. It does nothing in WSL and the desktop app.
- **Install:** `/plugin install mascot-wipe --marketplace shostako/mascot-wipe`. Nothing else to install: it runs on the PowerShell 5.1 that comes with Windows.
- **Commands:** `/mascot off`, `/mascot on`, and `/mascot status` when no face appears.
- **Tabs:** Windows Terminal tabs are told apart by their titles, so the face follows the selected tab and hides in a tab without a session. Tabs with the same title show the session that received a prompt last; start with `claude -n <name>` to keep them apart.
- **Cost:** the mood marker adds a short instruction to each prompt, which uses a few tokens.
- **Limits:** it does not run where company policy blocks PowerShell scripts.

Code is MIT. The pictures in `frames/` are CC0.

