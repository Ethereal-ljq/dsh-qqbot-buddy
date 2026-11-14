#!/usr/bin/env python3
"""faster-whisper worker: 读音频 -> 本地转写 -> stdout JSON（供 Node ASR 适配器调用）。

用法:
  python faster_whisper.py --model <dir|name> --audio <file> [--language auto]
      [--device auto] [--compute-type default] [--beam-size 5]
输出:
  {"text": "...", "language": "zh", "duration": 12.3}
失败时把原因写 stderr 并以非 0 退出。
"""
import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--audio', required=True)
    parser.add_argument('--language', default='auto')
    parser.add_argument('--device', default='auto')
    parser.add_argument('--compute-type', default='default')
    parser.add_argument('--beam-size', type=int, default=5)
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # noqa: BLE001
        print('faster-whisper 未安装: %s' % exc, file=sys.stderr)
        return 2

    try:
        compute_type = None if args.compute_type in ('', 'default') else args.compute_type
        device = args.device if args.device else 'auto'
        model = WhisperModel(args.model, device=device, compute_type=compute_type)
        language = None if args.language in ('', 'auto') else args.language
        segments, info = model.transcribe(
            args.audio,
            language=language,
            beam_size=max(1, args.beam_size),
            vad_filter=True,
        )
        text = ''.join(segment.text for segment in segments).strip()
        payload = {
            'text': text,
            'language': getattr(info, 'language', '') or '',
            'duration': float(getattr(info, 'duration', 0) or 0),
        }
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        print('转写失败: %s' % exc, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
