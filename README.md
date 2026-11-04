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

## 知っておくこと

- 1 つの窓に複数のタブがあるときは、最後に入力したセッションの顔を出す。タブを切り替えただけでは替わらない。
- マスコットは窓の上に重なるが、クリックは下の窓に通る。
- 感情の印のために、入力ごとに短い指示を足す。そのぶん少しトークンを使う。
- スクリプトの実行が会社の設定で止められている PC では動かない。

## ライセンス

コードは MIT、`frames/` の絵は CC0。
